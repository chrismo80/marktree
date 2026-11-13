import { markMatches } from "./preview";

const MARK = "find-match";

/** Ctrl+F in the preview: marks the query, Enter and Shift+Enter walk through the matches. */
export class FindBar {
  private readonly input: HTMLInputElement;
  private readonly count: HTMLElement;
  private matches: HTMLElement[] = [];
  private index = -1;

  constructor(
    private readonly bar: HTMLElement,
    private readonly article: HTMLElement,
    private readonly scroller: HTMLElement,
    private readonly onClose: () => void,
  ) {
    this.input = bar.querySelector("input")!;
    this.count = bar.querySelector(".find-count")!;
    this.input.addEventListener("input", () => this.search());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.step(e.shiftKey ? -1 : 1);
      else if (e.key === "Escape") this.close();
      else return;
      e.preventDefault();
      // Esc must not leave full screen as well.
      e.stopPropagation();
    });
    bar.querySelector<HTMLElement>(".find-previous")!.onclick = () => this.step(-1);
    bar.querySelector<HTMLElement>(".find-next")!.onclick = () => this.step(1);
    bar.querySelector<HTMLElement>(".find-close")!.onclick = () => this.close();
  }

  get isOpen(): boolean {
    return !this.bar.hidden;
  }

  /** A short selection becomes the query, as in a browser. */
  open(selection: string) {
    if (selection && !selection.includes("\n") && selection.length <= 100) this.input.value = selection;
    this.bar.hidden = false;
    this.input.focus();
    this.input.select();
    this.search();
  }

  close() {
    if (!this.isOpen) return;
    this.bar.hidden = true;
    markMatches(this.article, "", MARK);
    this.matches = [];
    this.scroller.focus();
    this.onClose();
  }

  /** Marks again after the document was rendered anew. */
  refresh() {
    if (this.isOpen) this.search();
  }

  private search() {
    const query = this.input.value.trim() ? this.input.value.toLocaleLowerCase() : "";
    markMatches(this.article, query, MARK);
    this.matches = [...this.article.querySelectorAll<HTMLElement>(`mark.${MARK}`)];
    // Like a browser, start from what is on screen instead of jumping back to the top.
    const top = this.scroller.getBoundingClientRect().top;
    this.index = Math.max(0, this.matches.findIndex((m) => m.getBoundingClientRect().bottom > top));
    this.show();
  }

  private step(direction: 1 | -1) {
    if (!this.matches.length) return;
    this.index = (this.index + direction + this.matches.length) % this.matches.length;
    this.show();
  }

  private show() {
    this.matches.forEach((mark, i) => mark.classList.toggle("current", i === this.index));
    this.matches[this.index]?.scrollIntoView({ block: "center" });
    this.count.textContent = this.matches.length
      ? `${this.index + 1} / ${this.matches.length}`
      : this.input.value.trim() ? "No results" : "";
  }
}
