export type OutlineItem = { title: string; dest: unknown; items?: OutlineItem[] };
export type OutlineDocument = {
  numPages: number;
  getOutline(): Promise<OutlineItem[] | null>;
  getDestination(name: string): Promise<unknown[] | null>;
  getPageIndex(ref: unknown): Promise<number>;
};

export async function outlinePage(doc: OutlineDocument, destination: unknown): Promise<number> {
  const explicit = typeof destination === "string" ? await doc.getDestination(destination) : destination;
  if (!Array.isArray(explicit)) throw new Error("Destino indisponível neste PDF.");
  const ref: unknown = explicit[0];
  const page = typeof ref === "number" && Number.isInteger(ref) ? ref + 1
    : ref && typeof ref === "object" ? (await doc.getPageIndex(ref)) + 1 : NaN;
  if (!Number.isInteger(page) || page < 1 || page > doc.numPages) throw new Error("Página indisponível neste PDF.");
  return page;
}

export class PdfOutline {
  private panel: HTMLElement;
  private list: HTMLElement;
  private status: HTMLElement;
  private doc: OutlineDocument | null = null;
  private revision = 0;
  private toggle: HTMLButtonElement | null;
  constructor(private root: HTMLElement, private navigate: (page: number) => unknown) {
    this.toggle = root.querySelector('[data-reader-action="pdf-outline"]');
    this.panel = document.createElement("aside");
    this.panel.className = "pdf-outline-panel";
    this.panel.id = "pdf-document-outline";
    this.panel.hidden = true;
    this.panel.setAttribute("aria-label", "Estrutura do documento");
    this.panel.innerHTML = '<header><h2>Estrutura do documento</h2><button type="button" aria-label="Minimizar sumário" title="Minimizar sumário">×</button></header><p role="status">Carregando sumário…</p><nav class="pdf-outline-list" aria-label="Sumário"></nav>';
    this.list = this.panel.querySelector<HTMLElement>("nav")!;
    this.status = this.panel.querySelector<HTMLElement>('[role="status"]')!;
    this.panel.querySelector("header button")!.addEventListener("click", () => this.close());
    this.panel.addEventListener("click", event => event.stopPropagation());
    this.panel.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); this.close(); }
      event.stopPropagation();
    });
    this.toggle?.setAttribute("aria-controls", this.panel.id);
    this.toggle?.setAttribute("aria-expanded", "false");
    root.append(this.panel);
  }
  toggleOpen(): void {
    this.panel.hidden = !this.panel.hidden;
    this.toggle?.setAttribute("aria-expanded", String(!this.panel.hidden));
    if (!this.panel.hidden) this.panel.querySelector<HTMLButtonElement>("header button")?.focus();
  }
  close(): void { this.panel.hidden = true; this.toggle?.setAttribute("aria-expanded", "false"); this.toggle?.focus(); }
  destroy(): void { this.revision++; this.doc = null; this.panel.remove(); }
  async load(doc: OutlineDocument): Promise<void> {
    this.doc = doc;
    const revision = ++this.revision;
    this.list.replaceChildren();
    this.status.textContent = "Carregando sumário…";
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outline = await Promise.race([doc.getOutline(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), 15000);
      })]);
      if (revision !== this.revision || !this.root.isConnected) return;
      this.status.textContent = outline?.length ? "" : "Este PDF não possui sumário incorporado.";
      if (outline?.length) this.addItems(outline, this.list);
    } catch {
      if (revision !== this.revision) return;
      this.status.textContent = "Não foi possível carregar o sumário.";
      const retry = document.createElement("button"); retry.type = "button"; retry.textContent = "Tentar novamente";
      retry.addEventListener("click", () => void this.load(doc));
      this.list.append(retry);
    } finally { clearTimeout(timer); }
  }
  private addItems(items: OutlineItem[], parent: HTMLElement): void {
    for (const item of items) {
      const row = document.createElement("div"); row.className = "pdf-outline-row";
      const link = document.createElement("button"); link.type = "button"; link.textContent = item.title || "Sem título";
      link.className = "pdf-outline-link";
      link.disabled = item.dest == null;
      link.addEventListener("click", async () => {
        const doc = this.doc;
        if (!doc) return;
        try {
          const page = await outlinePage(doc, item.dest);
          if (doc !== this.doc || !this.root.isConnected) return;
          this.navigate(page);
          this.list.querySelector('[aria-current="location"]')?.removeAttribute("aria-current");
          link.setAttribute("aria-current", "location");
          this.status.textContent = "";
          if (window.matchMedia("(max-width: 720px)").matches) this.close();
        } catch { this.status.textContent = "Não foi possível abrir este destino do sumário."; }
      });
      if (item.items?.length) {
        const expand = document.createElement("button"); expand.type = "button"; expand.textContent = "▸";
        expand.className = "pdf-outline-expand"; expand.setAttribute("aria-label", `Expandir ${item.title}`);
        expand.setAttribute("aria-expanded", "false");
        const children = document.createElement("div"); children.className = "pdf-outline-children"; children.hidden = true;
        expand.addEventListener("click", () => { children.hidden = !children.hidden; expand.textContent = children.hidden ? "▸" : "▾"; expand.setAttribute("aria-expanded", String(!children.hidden)); });
        row.append(expand, link); parent.append(row, children); this.addItems(item.items, children);
      } else { row.append(link); parent.append(row); }
    }
  }
}
