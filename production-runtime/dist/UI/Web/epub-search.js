// Serviço de busca textual dentro do livro (EPUB).
// Mantém a lógica pura e testável de normalização, contagem e localização de
// ocorrências a partir do texto dos capítulos, separada da manipulação do DOM.
export function normalizarEpub(valor) {
    return valor.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}
export function contarOcorrencias(texto, termo) {
    if (!termo)
        return 0;
    let total = 0;
    let inicio = 0;
    while (inicio < texto.length) {
        const indice = texto.indexOf(termo, inicio);
        if (indice < 0)
            break;
        total += 1;
        inicio = indice + termo.length;
    }
    return total;
}
// Busca um termo no conjunto de capítulos e devolve, em ordem, os capítulos
// que contêm o termo, com o total de ocorrências em cada um.
export function buscarNosCapitulos(capitulos, termoBruto) {
    const termo = normalizarEpub(termoBruto).trim().replace(/\s+/g, " ");
    if (!termo)
        return [];
    const resultados = [];
    for (const capitulo of capitulos) {
        const texto = normalizarEpub(capitulo.text).replace(/\s+/g, " ");
        const count = contarOcorrencias(texto, termo);
        if (count > 0) {
            resultados.push({ chapterIndex: capitulo.index, chapterName: capitulo.name, count });
        }
    }
    return resultados;
}
// Retorna os índices (posição absoluta no texto normalizado colapsado) onde o
// termo ocorre, para permitir navegar/realçar dentro do capítulo na ordem.
export function obterIndicesOcorrencias(texto, termoBruto) {
    const termo = normalizarEpub(termoBruto).trim().replace(/\s+/g, " ");
    if (!termo)
        return [];
    const textoNormalizado = normalizarEpub(texto).replace(/\s+/g, " ");
    const indices = [];
    let inicio = 0;
    while (inicio <= textoNormalizado.length - termo.length) {
        const indice = textoNormalizado.indexOf(termo, inicio);
        if (indice < 0)
            break;
        indices.push(indice);
        inicio = indice + termo.length;
    }
    return indices;
}
