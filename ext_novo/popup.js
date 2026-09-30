/**
 * POPUP - CADASTRAMENTO SICAD LOTE v3.0
 * Suporta múltiplos registros com texto individual por RG/registro.
 * Formato de entrada: blocos separados por "===" (primeira linha = RG, resto = texto)
 */

class PopupCadastroLote {
    constructor() {
        this.syncInterval = null;
        this.logExpandido = true;
        this.init();
    }

    async init() {
        this.bindEventos();
        await this.carregarConfiguracao();
        await this.sincronizarEstado();
        this.iniciarSincronizacao();

        // Listener de mensagens do background
        chrome.runtime.onMessage.addListener((msg) => {
            if (msg.action === 'updatePopup') this.handleUpdateBackground(msg);
        });
    }

    // ─── PARSE DE BLOCOS ────────────────────────────────────────────────────────

    /**
     * Lê o textarea e extrai array de { identificador, conteudo }
     * Separador de blocos: linha que contém apenas "==="
     * Primeira linha não-vazia do bloco = identificador
     * Demais linhas = conteúdo (até 2000 chars)
     */
    parseBlocos(texto) {
        if (!texto || !texto.trim()) return [];

        const blocos = texto.split(/^===\s*$/m);
        const registros = [];

        for (const bloco of blocos) {
            const linhas = bloco.split('\n').map(l => l.trimEnd());

            // Pular linhas vazias no início
            let inicio = 0;
            while (inicio < linhas.length && linhas[inicio].trim() === '') inicio++;
            if (inicio >= linhas.length) continue;

            const identificador = linhas[inicio].trim().replace(/\D/g, '');
            if (!identificador || identificador.length < 4 || identificador.length > 10) continue;

            const conteudo = linhas.slice(inicio + 1).join('\n').trim();
            if (!conteudo) continue;

            registros.push({
                identificador,
                conteudo: conteudo.substring(0, 2000),   // máx 2000 chars
                status: 'pendente'
            });
        }

        return registros;
    }

    // ─── EVENTOS ────────────────────────────────────────────────────────────────

    bindEventos() {
        const textarea = document.getElementById('listaRegistros');

        textarea.addEventListener('input', () => {
            this.atualizarContador();
            this.salvarConfiguracao();
        });

        textarea.addEventListener('paste', () => {
            setTimeout(() => {
                this.atualizarContador();
                this.salvarConfiguracao();
            }, 100);
        });

        document.getElementById('btnIniciar').addEventListener('click', () => this.iniciar());
        document.getElementById('btnParar').addEventListener('click', () => this.parar());
        document.getElementById('btnNormalizar').addEventListener('click', () => this.normalizar());

        // Opções
        ['autoSubmitOption', 'waitModalOption', 'delayBetweenOption'].forEach(id => {
            document.getElementById(id).addEventListener('change', () => this.salvarOpcoes());
        });

        // Log toggle
        document.getElementById('logHeader').addEventListener('click', () => this.toggleLog());

        // Ctrl+Enter = iniciar
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                const btn = document.getElementById('btnIniciar');
                if (!btn.disabled) this.iniciar();
            }
        });

        window.addEventListener('beforeunload', () => this.salvarConfiguracao());
    }

    // ─── CONTADOR E VALIDAÇÃO ────────────────────────────────────────────────────

    atualizarContador() {
        const registros = this.parseBlocos(document.getElementById('listaRegistros').value);
        const el = document.getElementById('contadorRegistros');
        const btn = document.getElementById('btnIniciar');

        if (registros.length === 0) {
            el.textContent = '0 registros detectados';
            el.className = '';
            btn.disabled = true;
        } else {
            el.textContent = `${registros.length} registro(s) detectado(s) ✓`;
            el.className = 'ok';
            btn.disabled = false;
        }
    }

    // ─── NORMALIZAR ──────────────────────────────────────────────────────────────

    normalizar() {
        const textarea = document.getElementById('listaRegistros');
        const registros = this.parseBlocos(textarea.value);

        if (registros.length === 0) {
            this.log('Nenhum registro válido para normalizar', 'error');
            return;
        }

        // Reconstruir textarea normalizado
        const normalizado = registros.map(r =>
            `${r.identificador}\n${r.conteudo}`
        ).join('\n\n===\n\n');

        textarea.style.opacity = '0.5';
        setTimeout(() => {
            textarea.value = normalizado;
            textarea.style.opacity = '1';
            this.atualizarContador();
            this.salvarConfiguracao();
            this.log(`${registros.length} registros normalizados`, 'success');
        }, 200);
    }

    // ─── INICIAR / PARAR ─────────────────────────────────────────────────────────

    async iniciar() {
        const registros = this.parseBlocos(document.getElementById('listaRegistros').value);

        if (registros.length === 0) {
            this.log('Nenhum registro para processar', 'error');
            return;
        }

        const opcoes = this.lerOpcoes();

        try {
            await chrome.runtime.sendMessage({
                action: 'iniciarProcesso',
                registros,
                opcoes
            });

            this.mostrarVisualizacaoProcessamento(true);
            this.log(`Processo iniciado: ${registros.length} registro(s)`, 'success');
        } catch (err) {
            this.log(`Erro ao iniciar: ${err.message}`, 'error');
        }
    }

    async parar() {
        try {
            await chrome.runtime.sendMessage({ action: 'pararProcesso' });
            this.log('Processo interrompido pelo usuário', 'error');
        } catch (err) {
            this.log(`Erro ao parar: ${err.message}`, 'error');
        }
    }

    // ─── OPÇÕES ──────────────────────────────────────────────────────────────────

    lerOpcoes() {
        return {
            autoSubmit: document.getElementById('autoSubmitOption').checked,
            aguardarModal: document.getElementById('waitModalOption').checked,
            intervaloItens: document.getElementById('delayBetweenOption').checked
        };
    }

    async salvarOpcoes() {
        const opcoes = this.lerOpcoes();
        await chrome.runtime.sendMessage({ action: 'salvarOpcoes', opcoes }).catch(() => {});
    }

    // ─── CONFIGURAÇÃO ────────────────────────────────────────────────────────────

    async salvarConfiguracao() {
        const dados = {
            listaTexto: document.getElementById('listaRegistros').value,
            opcoes: this.lerOpcoes()
        };
        await chrome.runtime.sendMessage({
            action: 'salvarConfiguracao',
            ...dados
        }).catch(() => {});

        const el = document.getElementById('saveStatus');
        if (el) { el.textContent = 'Salvo'; setTimeout(() => { el.textContent = ''; }, 2000); }
    }

    async carregarConfiguracao() {
        try {
            const resp = await chrome.runtime.sendMessage({ action: 'carregarConfiguracao' });

            if (resp.listaTexto) {
                document.getElementById('listaRegistros').value = resp.listaTexto;
                this.atualizarContador();
            }

            if (resp.opcoes) {
                document.getElementById('autoSubmitOption').checked  = resp.opcoes.autoSubmit  !== false;
                document.getElementById('waitModalOption').checked   = resp.opcoes.aguardarModal !== false;
                document.getElementById('delayBetweenOption').checked = resp.opcoes.intervaloItens !== false;
            }
        } catch (err) {
            console.error('Erro ao carregar config:', err);
        }
    }

    // ─── SINCRONIZAÇÃO DE ESTADO ──────────────────────────────────────────────────

    async sincronizarEstado() {
        try {
            const estado = await chrome.runtime.sendMessage({ action: 'obterEstado' });
            this.aplicarEstado(estado);
        } catch (err) { /* popup aberto antes do background */ }
    }

    iniciarSincronizacao() {
        this.syncInterval = setInterval(() => this.sincronizarEstado(), 1000);
        window.addEventListener('beforeunload', () => clearInterval(this.syncInterval));
    }

    handleUpdateBackground(msg) {
        if (msg.estado) this.aplicarEstado(msg.estado);
        if (msg.mensagem) this.log(msg.mensagem, msg.tipo || 'info');
    }

    aplicarEstado(estado) {
        if (!estado) return;

        const { contadores = {}, registros = [], processando = false, indiceAtual = 0 } = estado;
        const total = registros.length;
        const processados = (contadores.sucesso || 0) + (contadores.erro || 0);
        const pct = total > 0 ? (processados / total) * 100 : 0;

        // Contadores
        document.getElementById('countSucesso').textContent  = contadores.sucesso  || 0;
        document.getElementById('countErro').textContent     = contadores.erro     || 0;
        document.getElementById('countPendente').textContent = contadores.pendente || 0;

        // Progresso
        document.getElementById('progressoFill').style.width = `${pct}%`;
        document.getElementById('progressoNumero').textContent = `${processados}/${total}`;

        if (processando && total > 0) {
            const atual = registros[indiceAtual];
            document.getElementById('progressoLabel').textContent =
                atual ? `Processando RG ${atual.id || atual.identificador}…` : 'Processando…';
        } else if (!processando && processados === total && total > 0) {
            document.getElementById('progressoLabel').textContent = '✅ Concluído!';
        }

        // Visibilidade de seções
        this.mostrarVisualizacaoProcessamento(processando);

        // Dot de status
        document.getElementById('statusDot').style.background = processando ? '#fbbf24' : '#6ee7b7';
    }

    mostrarVisualizacaoProcessamento(ativo) {
        document.getElementById('progressoContainer').classList.toggle('visible', ativo);
        document.getElementById('contadoresRow').classList.toggle('visible', ativo);
        document.getElementById('btnParar').classList.toggle('visible', ativo);
        document.getElementById('btnIniciar').disabled = ativo;
        document.getElementById('btnNormalizar').disabled = ativo;
    }

    // ─── LOG ─────────────────────────────────────────────────────────────────────

    log(mensagem, tipo = 'info') {
        const icones = { info: '💡', success: '✅', error: '❌', processing: '🔄', warning: '⚠️' };
        const logContent = document.getElementById('logContent');
        const hora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

        const item = document.createElement('div');
        item.className = `log-item ${tipo}`;
        item.innerHTML = `<span>${icones[tipo] || '💡'}</span><span>${hora}</span><span>${mensagem}</span>`;
        logContent.appendChild(item);
        logContent.scrollTop = logContent.scrollHeight;

        // Manter apenas últimos 60 itens
        const todos = logContent.querySelectorAll('.log-item');
        if (todos.length > 60) todos[0].remove();
    }

    toggleLog() {
        this.logExpandido = !this.logExpandido;
        document.getElementById('logContent').style.display = this.logExpandido ? 'flex' : 'none';
        document.getElementById('logToggle').textContent = this.logExpandido ? '▼' : '▶';
    }
}

document.addEventListener('DOMContentLoaded', () => new PopupCadastroLote());
