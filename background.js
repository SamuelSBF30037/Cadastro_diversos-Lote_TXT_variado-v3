/**
 * BACKGROUND - CADASTRAMENTO SICAD LOTE v3.0
 *
 * Gerencia processamento sequencial de registros, cada um com seu próprio texto.
 * Estrutura de registro: { id, conteudo, status, tentativas }
 */

class GerenciadorBackground {
    constructor() {
        this.estado = {
            processando: false,
            registros: [],          // [{ id, conteudo, status, tentativas }]
            indiceAtual: 0,
            aguardandoResposta: false,
            contadores: { sucesso: 0, erro: 0, pendente: 0 },
            opcoes: { autoSubmit: true, aguardarModal: true, intervaloItens: true },
            tabId: null,
            tempoInicio: null
        };

        this.timeoutItem = null;
        this.TIMEOUT_MAX = 120000;  // 2 min por item

        this.setupListeners();
        this.carregarEstado();

        console.log('[BG] Gerenciador SICAD Lote v3.0 iniciado');
    }

    // ─── LISTENERS ───────────────────────────────────────────────────────────────

    setupListeners() {
        chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
            this.handleMessage(msg, sender, sendResponse);
            return true;
        });

        chrome.runtime.onInstalled.addListener(() => this.inicializarStorage());

        chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
            if (info.status === 'complete' && tab.url?.includes('cadastrarItem.jsp')) {
                this.injetarContentScript(tabId);
            }
        });

        chrome.tabs.onRemoved.addListener((tabId) => {
            if (tabId === this.estado.tabId && this.estado.processando) {
                console.log('[BG] Aba removida, procurando nova...');
                this.encontrarTab();
            }
        });
    }

    // ─── MENSAGENS ───────────────────────────────────────────────────────────────

    async handleMessage(msg, sender, sendResponse) {
        try {
            switch (msg.action) {

                case 'obterEstado':
                    sendResponse(this.estado);
                    break;

                case 'iniciarProcesso':
                    await this.iniciarProcesso(msg.registros, msg.opcoes);
                    sendResponse({ ok: true });
                    break;

                case 'pararProcesso':
                    await this.pararProcesso();
                    sendResponse({ ok: true });
                    break;

                case 'itemProcessado':
                    await this.handleItemProcessado(msg);
                    break;

                case 'salvarConfiguracao':
                    await chrome.storage.local.set({
                        listaTexto: msg.listaTexto || '',
                        opcoes:     msg.opcoes    || this.estado.opcoes
                    });
                    sendResponse({ ok: true });
                    break;

                case 'carregarConfiguracao': {
                    const r = await chrome.storage.local.get(['listaTexto', 'opcoes']);
                    sendResponse({
                        listaTexto: r.listaTexto || '',
                        opcoes: r.opcoes || this.estado.opcoes
                    });
                    break;
                }

                case 'salvarOpcoes':
                    this.estado.opcoes = msg.opcoes;
                    await chrome.storage.local.set({ opcoes: msg.opcoes });
                    sendResponse({ ok: true });
                    break;

                default:
                    sendResponse({ error: 'Ação desconhecida' });
            }
        } catch (err) {
            console.error('[BG] Erro handleMessage:', err);
            sendResponse({ error: err.message });
        }
    }

    // ─── STORAGE ─────────────────────────────────────────────────────────────────

    async inicializarStorage() {
        const r = await chrome.storage.local.get(['_init']);
        if (!r._init) {
            await chrome.storage.local.set({ _init: true, listaTexto: '', opcoes: this.estado.opcoes });
        }
    }

    async carregarEstado() {
        try {
            const r = await chrome.storage.local.get(['estadoBG', 'opcoes']);
            if (r.estadoBG) {
                this.estado = { ...this.estado, ...r.estadoBG };
                // Nunca retomar processo automaticamente
                this.estado.processando = false;
                this.estado.aguardandoResposta = false;
            }
            if (r.opcoes) this.estado.opcoes = r.opcoes;
        } catch (err) {
            console.error('[BG] Erro carregarEstado:', err);
        }
    }

    async salvarEstado() {
        await chrome.storage.local.set({ estadoBG: this.estado }).catch(() => {});
    }

    // ─── PROCESSO PRINCIPAL ───────────────────────────────────────────────────────

    async iniciarProcesso(registros, opcoes) {
        console.log(`[BG] Iniciando: ${registros.length} registros`);

        // Montar lista interna
        this.estado.registros = registros.map(r => ({
            id:         r.identificador || r.id,
            conteudo:   r.conteudo,
            status:     'pendente',
            tentativas: 0
        }));

        this.estado.processando        = true;
        this.estado.aguardandoResposta = false;
        this.estado.indiceAtual        = 0;
        this.estado.opcoes             = opcoes || this.estado.opcoes;
        this.estado.contadores         = { sucesso: 0, erro: 0, pendente: registros.length };
        this.estado.tempoInicio        = Date.now();

        await this.encontrarTab();

        if (!this.estado.tabId) {
            this.estado.processando = false;
            await this.salvarEstado();
            this.notificar('error', '❌ Abra a página cadastrarItem.jsp do SICAD antes de iniciar.');
            return;
        }

        await this.salvarEstado();
        this.processarProximoItem();
    }

    async pararProcesso() {
        if (this.timeoutItem) { clearTimeout(this.timeoutItem); this.timeoutItem = null; }
        this.estado.processando        = false;
        this.estado.aguardandoResposta = false;
        await this.salvarEstado();
        this.notificar('error', 'Processo interrompido pelo usuário');
    }

    // ─── SEQUÊNCIA ITEM A ITEM ────────────────────────────────────────────────────

    async processarProximoItem() {
        if (!this.estado.processando)           return;
        if (this.estado.aguardandoResposta)     return;
        if (this.estado.indiceAtual >= this.estado.registros.length) {
            await this.finalizar();
            return;
        }

        const item = this.estado.registros[this.estado.indiceAtual];
        console.log(`[BG] Item ${this.estado.indiceAtual + 1}/${this.estado.registros.length}: RG ${item.id}`);

        item.status     = 'processando';
        item.tentativas++;
        this.estado.aguardandoResposta = true;

        await this.salvarEstado();
        this.notificar('processing',
            `Processando RG ${item.id} (${this.estado.indiceAtual + 1}/${this.estado.registros.length})`
        );

        try {
            await chrome.tabs.get(this.estado.tabId);
        } catch {
            await this.encontrarTab();
            if (!this.estado.tabId) {
                await this.erroItem(item, 'Aba do SICAD não encontrada');
                return;
            }
        }

        // Timeout de segurança
        this.timeoutItem = setTimeout(() => {
            if (this.estado.aguardandoResposta) {
                this.erroItem(item, 'Timeout — item não respondeu em 2 minutos');
            }
        }, this.TIMEOUT_MAX);

        try {
            await chrome.tabs.sendMessage(this.estado.tabId, {
                action:       'processarItem',
                identificador: item.id,
                conteudo:      item.conteudo,
                opcoes:        this.estado.opcoes
            });
        } catch (err) {
            clearTimeout(this.timeoutItem);
            await this.erroItem(item, `Erro de comunicação: ${err.message}`);
        }
    }

    async handleItemProcessado(msg) {
        if (this.timeoutItem) { clearTimeout(this.timeoutItem); this.timeoutItem = null; }
        if (!this.estado.aguardandoResposta) return;

        this.estado.aguardandoResposta = false;
        const item = this.estado.registros[this.estado.indiceAtual];

        if (!item || item.id !== msg.identificador) return;

        if (msg.sucesso) {
            await this.sucessoItem(item, msg.detalhes);
        } else {
            await this.erroItem(item, msg.erro || 'Erro desconhecido');
        }
    }

    async sucessoItem(item, detalhe) {
        item.status = 'sucesso';
        this.estado.contadores.sucesso++;
        this.estado.contadores.pendente--;
        this.estado.indiceAtual++;
        await this.salvarEstado();
        this.notificar('update', null);

        const delay = this.estado.opcoes.intervaloItens ? 3000 : 1000;
        setTimeout(() => this.processarProximoItem(), delay);
    }

    async erroItem(item, mensagem) {
        console.error(`[BG] Erro RG ${item.id}: ${mensagem}`);
        item.status  = 'erro';
        item.mensagem = mensagem;
        this.estado.contadores.erro++;
        this.estado.contadores.pendente--;
        this.estado.aguardandoResposta = false;
        this.estado.indiceAtual++;
        await this.salvarEstado();
        this.notificar('update', null);

        setTimeout(() => this.processarProximoItem(), 5000);
    }

    async finalizar() {
        const total = this.estado.registros.length;
        const s = this.estado.contadores.sucesso;
        const e = this.estado.contadores.erro;

        this.estado.processando        = false;
        this.estado.aguardandoResposta = false;
        await this.salvarEstado();

        const msg = `✅ Concluído! ${s} sucesso(s), ${e} erro(s) de ${total}`;
        this.notificar(e > 0 ? 'warning' : 'success', msg);
        console.log(`[BG] ${msg}`);
    }

    // ─── ABAS ─────────────────────────────────────────────────────────────────────

    async encontrarTab() {
        try {
            const tabs = await chrome.tabs.query({});
            const tab  = tabs.find(t => t.url?.includes('cadastrarItem.jsp'));
            if (tab) {
                this.estado.tabId = tab.id;
                await this.injetarContentScript(tab.id);
            } else {
                this.estado.tabId = null;
            }
        } catch (err) {
            this.estado.tabId = null;
        }
    }

    async injetarContentScript(tabId) {
        try {
            await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
        } catch {
            // Já injetado ou sem permissão — ignorar
        }
    }

    // ─── NOTIFICAÇÕES ────────────────────────────────────────────────────────────

    notificar(tipo, mensagem) {
        chrome.runtime.sendMessage({
            action: 'updatePopup',
            tipo,
            mensagem,
            estado: this.estado
        }).catch(() => {});
    }
}

const gerenciador = new GerenciadorBackground();
