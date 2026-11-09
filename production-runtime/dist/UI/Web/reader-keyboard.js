export function resolverTeclaEpubIframe(tecla, direcaoLeitura) {
    if (tecla.alvoProtegido)
        return null;
    if (tecla.ctrlKey || tecla.metaKey || tecla.altKey)
        return null;
    if (tecla.key === "ArrowLeft")
        return direcaoLeitura === "rtl" ? "proxima-pagina" : "pagina-anterior";
    if (tecla.key === "ArrowRight")
        return direcaoLeitura === "rtl" ? "pagina-anterior" : "proxima-pagina";
    if (tecla.key === "ArrowUp")
        return "topo-pagina";
    if (tecla.key === "ArrowDown")
        return "fim-pagina";
    if (tecla.key === "PageUp")
        return "pagina-anterior";
    if (tecla.key === "PageDown" || tecla.key === " ")
        return "proxima-pagina";
    if (tecla.key === "Home")
        return "topo-pagina";
    if (tecla.key === "End")
        return "fim-pagina";
    return null;
}
export function resolverAtalhoLeitor(tecla, contexto) {
    if (!contexto.leitorAtivo)
        return null;
    const chave = tecla.key.toLowerCase();
    const controle = Boolean(tecla.ctrlKey || tecla.metaKey);
    if (contexto.leitorPdf && controle && !tecla.altKey && chave === "f")
        return "abrir-pesquisa-pdf";
    if (contexto.leitorEpub && controle && !tecla.altKey && chave === "f")
        return "abrir-pesquisa-epub";
    if (tecla.key === "Escape") {
        if (contexto.leitorPdf && contexto.pesquisaPdfAberta)
            return "fechar-pesquisa-pdf";
        if (contexto.leitorEpub && contexto.pesquisaEpubAberta)
            return "fechar-pesquisa-epub";
        if (contexto.telaCheia)
            return "sair-tela-cheia";
        if (contexto.controlesVisiveis)
            return "fechar-controles";
        return "fechar-leitor";
    }
    if (contexto.alvoProtegido)
        return null;
    if (contexto.leitorPdf && !controle && !tecla.altKey && !tecla.shiftKey && tecla.key === "/")
        return "abrir-pesquisa-pdf";
    if (contexto.leitorEpub && !controle && !tecla.altKey && !tecla.shiftKey && tecla.key === "/")
        return "abrir-pesquisa-epub";
    if (controle || tecla.altKey || tecla.metaKey)
        return null;
    if (tecla.key === "ArrowLeft")
        return contexto.direcaoLeitura === "rtl" ? "proxima-pagina" : "pagina-anterior";
    if (tecla.key === "ArrowRight")
        return contexto.direcaoLeitura === "rtl" ? "pagina-anterior" : "proxima-pagina";
    if (tecla.key === "ArrowUp")
        return "topo-pagina";
    if (tecla.key === "ArrowDown")
        return "fim-pagina";
    if (tecla.key === "PageUp")
        return "pagina-anterior";
    if (tecla.key === "PageDown")
        return "proxima-pagina";
    if (tecla.key === " ")
        return tecla.shiftKey ? "pagina-anterior" : "proxima-pagina";
    if (tecla.key === "Home")
        return "primeira-pagina";
    if (tecla.key === "End")
        return "ultima-pagina";
    if (chave === "f" && contexto.telaCheiaDisponivel)
        return "alternar-tela-cheia";
    if (chave === "m")
        return "alternar-modo";
    if (chave === "c")
        return "alternar-controles";
    if (chave === "b")
        return "alternar-marcador";
    if (tecla.key === "[")
        return "capitulo-anterior";
    if (tecla.key === "]")
        return "proximo-capitulo";
    if (tecla.key === "+" || tecla.key === "=")
        return "aumentar-zoom";
    if (tecla.key === "-")
        return "diminuir-zoom";
    if (tecla.key === "0")
        return "resetar-zoom";
    return null;
}
