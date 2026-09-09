/**
 * CONTENT SCRIPT - CADASTRAMENTO SICAD LOTE v3.1
 *
 * Fix v3.1 (produção):
 * - preencherTexto usa nativeInputValueSetter (React/Prototype compat) + digitação lenta
 *   como fallback garantido, pois produção valida via document.formu.textoItem.value
 * - submeter chama validaFormu('insert') diretamente no contexto do iframe quando possível,
 *   evitando o alert "Digite o Texto do item!" que ocorria com .click() no botão
 * - getDoc/getWin rastreiam TODOS os iframes aninhados (produção usa frames dentro de frames)
 * - aguardarDados aguarda campo com value != '' (servidor preenche campos ao carregar RG)
 */

if (!window.location.href.includes('cadastrarItem.jsp')) {
    // Página errada — silencioso
} else if (typeof window.__SICADExecutorAtivo !== 'undefined') {
    // Já injetado — silencioso
} else {
    window.__SICADExecutorAtivo = true;

    class ExecutorCadastros {
        constructor() {
            this.ocupado = false;

            this.selRG = [
                '#rgMilitar',
                'input[name="rgMilitar"]',
                'input[id="rgMilitar"]',
                'input[maxlength="6"]',
                'input[maxlength="7"]',
                'input[maxlength="8"]',
                'input.frm-obrigatorio[type="text"]'
            ];

            this.selTexto = [
                '#textoItem',
                'textarea[name="textoItem"]',
                'textarea[id="textoItem"]',
                'textarea.frm-obrigatorio',
                'textarea[cols]',
                'textarea[rows]'
            ];

            this.selSubmit = [
                'input[type="button"][value="Incluir"]',
                'input[type="button"][onclick*="validaFormu"]',
                'input[type="button"][onclick*="insert"]',
                'input[value="Incluir"]'
            ];

            this.setupListener();
            this.setupModalObserver();

            console.log('[CS] Executor SICAD v3.1 ativo');
        }

        // ─── LISTENER ─────────────────────────────────────────────────────────────

        setupListener() {
            chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
                if (msg.action !== 'processarItem') {
                    sendResponse({ status: 'ignorado' });
                    return true;
                }
                if (this.ocupado) {
                    sendResponse({ status: 'ocupado' });
                    return true;
                }
                sendResponse({ status: 'aceito' });
                this.processar(msg.identificador, msg.conteudo, msg.opcoes);
                return true;
            });
        }

        // ─── MODAL OBSERVER ───────────────────────────────────────────────────────

        setupModalObserver() {
            this._modalDetectado = false;
            this._modalObserver = new MutationObserver((mutations) => {
                if (!this.ocupado) return;
                for (const m of mutations) {
                    for (const node of m.addedNodes) {
                        if (node.nodeType !== 1) continue;
                        if (node.id?.includes('modal_dialog') || node.classList?.contains('dialog')) {
                            this._modalDetectado = true;
                            setTimeout(() => this.fecharModal(node), 400);
                        }
                    }
                }
            });
            this._modalObserver.observe(document.body, { childList: true, subtree: true });
        }

        // ─── PROCESSO PRINCIPAL ───────────────────────────────────────────────────

        async processar(identificador, conteudo, opcoes = {}) {
            if (this.ocupado) return;
            this.ocupado = true;
            this._modalDetectado = false;

            console.log(`[CS] Processando RG: ${identificador}`);

            try {
                // 1. Preencher RG
                if (!await this.preencherRG(identificador)) {
                    throw new Error('Falha ao preencher RG');
                }

                // 2. Aguardar dados do servidor carregarem
                await this.aguardarDados();

                // 3. Preencher texto individual — método robusto para produção
                if (!await this.preencherTexto(conteudo)) {
                    throw new Error('Falha ao preencher texto');
                }

                // 4. Submeter
                if (opcoes.autoSubmit !== false) {
                    if (!await this.submeter()) {
                        throw new Error('Falha ao submeter');
                    }

                    // 5. Fechar modais
                    if (opcoes.aguardarModal !== false) {
                        await this.aguardarEFecharModais();
                    }
                }

                console.log(`[CS] ✅ RG ${identificador} concluído`);
                this.responder(identificador, true, 'Cadastrado com sucesso');

            } catch (err) {
                console.error(`[CS] ❌ Erro RG ${identificador}:`, err);
                this.responder(identificador, false, err.message);
            } finally {
                this.ocupado = false;
            }
        }

        // ─── PREENCHER RG ──────────────────────────────────────────────────────────

        async preencherRG(rg) {
            try {
                const doc   = this.getDoc();
                const campo = this.acharCampo(doc, this.selRG);
                if (!campo) throw new Error('Campo RG não encontrado');

                campo.focus();
                campo.value = '';
                this.disparar(campo, ['focus', 'click']);
                await this.esperar(200);

                // Atribuição direta primeiro
                campo.value = rg;
                this.disparar(campo, ['input', 'change', 'keyup', 'blur']);
                await this.esperar(400);

                // Verificar — fallback lento se necessário
                if (campo.value.replace(/\D/g, '') !== rg.replace(/\D/g, '')) {
                    campo.value = '';
                    campo.focus();
                    await this.digitarDevagar(campo, rg);
                    this.disparar(campo, ['change', 'blur']);
                    await this.esperar(300);
                }

                console.log(`[CS] RG preenchido: ${campo.value}`);
                return true;

            } catch (err) {
                console.error('[CS] preencherRG:', err);
                return false;
            }
        }

        // ─── AGUARDAR DADOS DO SERVIDOR ───────────────────────────────────────────

        /**
         * Aguarda o campo "postoGraduacao" ou "nomePessoa" ser preenchido pelo servidor
         * (onBlur do RG faz submit e recarrega dados). Máx 10s.
         */
        async aguardarDados() {
            // O onBlur do rgMilitar chama execAcao('pesquisa') que faz submit do frame.
            // O servidor responde e o frame é recarregado com os dados do RG.
            // Precisamos esperar:
            //   1. nomePessoa/postoGraduacao preenchidos (servidor respondeu)
            //   2. textoItem presente e vazio (DOM estabilizou, pronto para receber texto)
            //   3. Pausa adicional para garantir que nenhum script da página ainda está rodando

            // Passo 1: aguardar servidor preencher campos do RG
            // Sempre re-busca via getDoc() para não usar referência stale
            await this.aguardarCondicao(() => {
                try {
                    const doc    = this.getDoc();
                    const nomeEl = doc.querySelector('input[name="nomePessoa"], input[name="postoGraduacao"]');
                    return nomeEl && nomeEl.value && nomeEl.value.trim().length > 0;
                } catch { return false; }
            }, 12000);

            // Passo 2: aguardar textoItem presente e vazio (DOM fresco pós-reload)
            await this.aguardarCondicao(() => {
                try {
                    const campo = this.acharCampo(this.getDoc(), this.selTexto);
                    // Deve existir E estar vazio (se tiver valor, ainda é o reload antigo)
                    return campo !== null && campo.value === '';
                } catch { return false; }
            }, 8000);

            // Passo 3: pausa de estabilização — scripts da página terminam de rodar
            await this.esperar(800);
        }

        // ─── PREENCHER TEXTO (CRÍTICO - FIX TIMING PRODUÇÃO) ─────────────────────

        /**
         * Produção valida via: document.formu.textoItem.value == ""
         *
         * Fluxo:
         * 1. Setter nativo (bypass Prototype.js)
         * 2. Fallback: digitação lenta (caractere a caractere)
         * 3. Fallback: execCommand insertText
         * 4. AGUARDA até document.formu.textoItem.value estar preenchido (looping)
         *    → só retorna true quando confirmado, evitando submit prematuro
         */
        async preencherTexto(conteudo) {
            try {
                // ── Re-buscar doc/win AGORA, pós-reload do servidor ──────────────────
                // O onBlur do campo rgMilitar dispara execAcao('pesquisa'), que recarrega
                // o frame inteiro com os dados do servidor. Qualquer referência a doc/campo
                // capturada ANTES desse reload está stale (nó descartado do DOM).
                // getDoc() percorre os iframes a cada chamada → sempre retorna referência fresca.

                // Aguardar o campo textoItem no DOM fresco (pós-reload)
                const campo = await this.aguardarElemento(
                    () => this.acharCampo(this.getDoc(), this.selTexto),
                    15000
                );
                if (!campo) throw new Error('Campo de texto não encontrado no DOM');

                // Capturar doc/win após garantir que o campo existe no DOM atual
                const doc = this.getDoc();
                const win = this.getWin();

                // ── Limpar ──
                campo.focus();
                await this.esperar(300);
                campo.value = '';
                this.disparar(campo, ['input', 'change']);
                await this.esperar(200);

                // ── Tentativa 1: setter nativo ──
                try {
                    const nativeSetter = Object.getOwnPropertyDescriptor(
                        win.HTMLTextAreaElement.prototype, 'value'
                    )?.set;
                    if (nativeSetter) {
                        nativeSetter.call(campo, conteudo);
                    } else {
                        campo.value = conteudo;
                    }
                } catch {
                    campo.value = conteudo;
                }
                this.disparar(campo, ['input', 'change', 'keyup', 'paste']);
                await this.esperar(400);

                // ── Tentativa 2: digitação lenta se ainda vazio ──
                if (!campo.value || campo.value.trim().length === 0) {
                    console.warn('[CS] Setter falhou → digitando devagar...');
                    campo.value = '';
                    campo.focus();
                    await this.digitarDevagar(campo, conteudo);
                    this.disparar(campo, ['input', 'change', 'blur']);
                    await this.esperar(400);
                }

                // ── Tentativa 3: execCommand ──
                if (!campo.value || campo.value.trim().length === 0) {
                    console.warn('[CS] Digitação falhou → execCommand...');
                    campo.focus();
                    try {
                        const iDoc = doc === document ? document : doc;
                        iDoc.execCommand('selectAll');
                        iDoc.execCommand('insertText', false, conteudo);
                    } catch {
                        campo.value = conteudo;
                    }
                    await this.esperar(400);
                }

                if (!campo.value || campo.value.trim().length === 0) {
                    throw new Error('Texto continua vazio após todas as tentativas de preenchimento');
                }

                // ── Chamar Contar() da página ──
                try {
                    if (typeof win.Contar === 'function') win.Contar(campo);
                } catch { /* ignorar */ }

                this.disparar(campo, ['blur']);

                // ── ESPERA CRÍTICA: confirmar que document.formu.textoItem.value != "" ──
                // Essa é a mesma verificação que validaFormu() faz antes do submit.
                // Só avançamos quando tiver certeza que o valor está lá.
                const confirmado = await this.aguardarCondicao(() => {
                    try {
                        // Verifica direto no form, como o validaFormu faz
                        const formu = doc.querySelector('form[name="formu"]') ||
                                      win.document?.formu;
                        if (formu?.textoItem?.value?.trim().length > 0) return true;
                    } catch {}
                    // Fallback: checar pelo elemento diretamente
                    return campo.value && campo.value.trim().length > 0;
                }, 5000);

                if (!confirmado) {
                    throw new Error('Validação final: campo texto não confirmado após 5s');
                }

                console.log(`[CS] ✅ Texto confirmado no campo: ${campo.value.length} chars`);
                return true;

            } catch (err) {
                console.error('[CS] preencherTexto:', err);
                return false;
            }
        }

        // ─── SUBMETER ─────────────────────────────────────────────────────────────

        /**
         * Só chega aqui DEPOIS que preencherTexto() confirmou o valor.
         * 
         * Ordem de preferência:
         * 1. execAcao('insert') — pula a validação JS que causava o alert
         * 2. validaFormu('insert') — com texto já confirmado, não vai disparar alert
         * 3. .click() no botão — último recurso
         *
         * Em todas as estratégias: pausa de 1s antes + reconfirmação do campo.
         */
        async submeter() {
            try {
                // Pausa de segurança — garantir que nenhum evento ainda está propagando
                await this.esperar(800);

                // Sempre referências frescas
                const doc = this.getDoc();
                const win = this.getWin();

                // Reconfirmar o campo via referência fresca do DOM
                const campoTexto = this.acharCampo(doc, this.selTexto);
                if (!campoTexto || !campoTexto.value || campoTexto.value.trim().length === 0) {
                    throw new Error('Campo texto vazio no momento do submit — abortando');
                }

                // Reconfirmar também via document.formu (como a validação da página faz)
                try {
                    const formu = doc.forms['formu'] || doc.querySelector('form[name="formu"]');
                    if (formu && formu.textoItem) {
                        if (!formu.textoItem.value || formu.textoItem.value.trim().length === 0) {
                            throw new Error('formu.textoItem.value vazio — sincronização incompleta');
                        }
                    }
                } catch (e) {
                    if (e.message.includes('formu.textoItem')) throw e;
                    // Ignorar erros de acesso cross-frame
                }

                console.log(`[CS] Submetendo — ${campoTexto.value.length} chars confirmados`);

                // ── Estratégia 1: execAcao('insert') — bypassa validação do alert ──
                try {
                    if (typeof win.execAcao === 'function') {
                        win.execAcao('insert');
                        await this.esperar(2500);
                        console.log('[CS] Submetido via execAcao()');
                        return true;
                    }
                } catch (e) {
                    console.warn('[CS] execAcao falhou:', e.message);
                }

                // ── Estratégia 2: validaFormu('insert') — texto já confirmado ──
                try {
                    if (typeof win.validaFormu === 'function') {
                        win.validaFormu('insert');
                        await this.esperar(2500);
                        console.log('[CS] Submetido via validaFormu()');
                        return true;
                    }
                } catch (e) {
                    console.warn('[CS] validaFormu falhou:', e.message);
                }

                // ── Estratégia 3: .click() no botão ──
                const btn = this.acharBotao(doc);
                if (!btn) throw new Error('Botão de submissão não encontrado');
                if (btn.disabled) await this.aguardarHabilitado(btn, 10000);
                btn.focus();
                await this.esperar(300);
                btn.click();
                await this.esperar(2500);
                console.log('[CS] Submetido via .click()');
                return true;

            } catch (err) {
                console.error('[CS] submeter:', err);
                return false;
            }
        }

        // ─── MODAIS ───────────────────────────────────────────────────────────────

        async aguardarEFecharModais() {
            await this.esperar(3000);

            if (this._modalDetectado) {
                await this.esperar(1500);
                return;
            }

            return new Promise((resolve) => {
                let tentativas = 0;
                const MAX = 15;

                const checar = () => {
                    if (this._modalDetectado || this.procurarEFecharModal()) {
                        setTimeout(resolve, 1500);
                        return;
                    }
                    if (++tentativas >= MAX) { resolve(); return; }
                    setTimeout(checar, 800);
                };

                checar();
            });
        }

        procurarEFecharModal() {
            for (const el of document.querySelectorAll('div[id*="modal_dialog"]')) {
                if (this.visivel(el)) { this.fecharModal(el); return true; }
            }
            for (const el of document.querySelectorAll('div.dialog')) {
                if (this.visivel(el)) { this.fecharModal(el); return true; }
            }
            for (const el of document.querySelectorAll('div')) {
                const z = parseInt(window.getComputedStyle(el).zIndex);
                if (z > 1000 && this.visivel(el)) {
                    const temX     = el.querySelector('.mac_os_x_close');
                    const temTexto = el.textContent?.includes('incluído com sucesso') ||
                                     el.textContent?.includes('novo item');
                    if (temX || temTexto) { this.fecharModal(el); return true; }
                }
            }
            return false;
        }

        fecharModal(modal) {
            const x = modal.querySelector('.mac_os_x_close');
            if (x) { try { x.click(); return; } catch {} }

            for (const el of modal.querySelectorAll('a, div[onclick]')) {
                const txt = (el.textContent || '').toLowerCase();
                const oc  = el.getAttribute('onclick') || '';
                if (txt.includes('clique aqui') || txt.includes('novo item') ||
                    oc.includes('Dialog.closeInfo') || oc.includes('Windows.close')) {
                    try { el.click(); return; } catch {}
                }
            }

            try {
                const id = modal.id;
                if (id && window.Windows?.close) { window.Windows.close(id); return; }
            } catch {}
            try {
                if (window.Dialog?.closeInfo) { window.Dialog.closeInfo(); return; }
            } catch {}

            setTimeout(() => {
                if (document.body.contains(modal) && this.visivel(modal)) {
                    try { modal.remove(); } catch {}
                }
            }, 2000);
        }

        // ─── UTILITÁRIOS ──────────────────────────────────────────────────────────

        /**
         * Retorna o documento do iframe mais profundo que contém o formulário SICAD.
         * Produção usa iframes aninhados (frame → sub-frame com o form).
         */
        getDoc() {
            const iframe = this.acharIframeComForm();
            if (iframe) {
                try { return iframe.contentDocument || iframe.contentWindow.document; } catch {}
            }
            return document;
        }

        getWin() {
            const iframe = this.acharIframeComForm();
            if (iframe) { try { return iframe.contentWindow; } catch {} }
            return window;
        }

        acharIframeComForm() {
            // Busca recursiva por iframe que contenha o formulário 'formu'
            return this._buscarIframeComForm(document) || null;
        }

        _buscarIframeComForm(doc) {
            // Checar se este documento já tem o form
            if (doc.querySelector('form[name="formu"]')) return null; // já é o doc principal

            const iframes = doc.querySelectorAll('iframe');
            for (const iframe of iframes) {
                try {
                    const iDoc = iframe.contentDocument || iframe.contentWindow?.document;
                    if (!iDoc) continue;

                    // Verifica se tem o formulário
                    if (iDoc.querySelector('form[name="formu"]') ||
                        iDoc.querySelector('#textoItem') ||
                        iDoc.querySelector('input[name="rgMilitar"]')) {
                        return iframe;
                    }

                    // Busca recursiva
                    const sub = this._buscarIframeComForm(iDoc);
                    if (sub) return sub;
                } catch { /* cross-origin — ignorar */ }
            }
            return null;
        }

        acharCampo(doc, seletores) {
            for (const sel of seletores) {
                try {
                    const el = doc.querySelector(sel);
                    if (el && this.visivel(el)) return el;
                } catch {}
            }
            return null;
        }

        acharBotao(doc) {
            for (const sel of this.selSubmit) {
                try {
                    const el = doc.querySelector(sel);
                    if (el && this.visivel(el)) return el;
                } catch {}
            }
            for (const el of doc.querySelectorAll('button, input[type="button"], input[type="submit"]')) {
                const t = (el.textContent || el.value || '').toLowerCase();
                if (['salvar','gravar','incluir','enviar','submit','cadastrar'].some(w => t.includes(w))) {
                    if (this.visivel(el)) return el;
                }
            }
            return null;
        }

        visivel(el) {
            if (!el) return false;
            try {
                const s = window.getComputedStyle(el);
                const r = el.getBoundingClientRect();
                return s.display !== 'none' && s.visibility !== 'hidden' &&
                       s.opacity !== '0' && (r.width > 0 || r.height > 0);
            } catch { return true; } // dentro de iframe — assumir visível
        }

        disparar(el, eventos) {
            for (const tipo of eventos) {
                try { el.dispatchEvent(new Event(tipo, { bubbles: true })); } catch {}
            }
        }

        async digitarDevagar(campo, texto) {
            campo.focus();
            for (const ch of texto) {
                campo.value += ch;
                campo.dispatchEvent(new Event('input', { bubbles: true }));
                await this.esperar(25); // mais rápido que v3.0 (era 40ms)
            }
        }

        aguardarElemento(fn, timeout = 10000) {
            return new Promise((resolve) => {
                const fim = Date.now() + timeout;
                const checar = () => {
                    const el = fn();
                    if (el) { resolve(el); return; }
                    if (Date.now() >= fim) { resolve(null); return; }
                    setTimeout(checar, 250);
                };
                checar();
            });
        }

        aguardarCondicao(fn, timeout = 10000) {
            return new Promise((resolve) => {
                const fim = Date.now() + timeout;
                const checar = () => {
                    if (fn()) { resolve(true); return; }
                    if (Date.now() >= fim) { resolve(false); return; }
                    setTimeout(checar, 300);
                };
                checar();
            });
        }

        aguardarHabilitado(el, timeout = 10000) {
            return new Promise((resolve) => {
                const fim = Date.now() + timeout;
                const checar = () => {
                    if (!el.disabled) { resolve(true); return; }
                    if (Date.now() >= fim) { resolve(false); return; }
                    setTimeout(checar, 250);
                };
                checar();
            });
        }

        esperar(ms) {
            return new Promise(r => setTimeout(r, ms));
        }

        responder(identificador, sucesso, detalhe) {
            chrome.runtime.sendMessage({
                action:        'itemProcessado',
                identificador,
                sucesso,
                erro:    sucesso ? null : detalhe,
                detalhes: detalhe
            }).catch(() => {});
        }
    }

    new ExecutorCadastros();
    console.log('[CS] ExecutorCadastros SICAD v3.1 registrado');
}
