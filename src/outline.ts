const MIN_HEADINGS = 3;
// A heading that was just jumped to sits exactly at the top edge, so it must already count as read.
const READING_LINE_OFFSET = 24;

type Entry = { heading: HTMLElement; link: HTMLAnchorElement };

/** The headings of the open document, with the section being read marked while scrolling. */
export class Outline {
  private entries: Entry[] = [];
  private current: Entry | undefined;

  constructor(
    private readonly nav: HTMLElement,
    private readonly scroller: HTMLElement,
    private readonly onSelect: (id: string) => void,
  ) {
    scroller.addEventListener("scroll", () => this.markCurrent(), { passive: true });
  }

  /** Returns whether the document has enough headings to be worth an outline. */
  update(article: HTMLElement | null): boolean {
    const headings = article ? [...article.querySelectorAll<HTMLElement>("h1[id], h2[id], h3[id]")] : [];
    this.entries = headings.map((heading) => {
      const link = document.createElement("a");
      link.className = `outline-${heading.tagName.toLowerCase()}`;
      link.href = `#${heading.id}`;
      link.textContent = heading.textContent;
      link.title = heading.textContent ?? "";
      link.onclick = (e) => {
        e.preventDefault();
        this.onSelect(heading.id);
      };
      return { heading, link };
    });
    this.current = undefined;
    this.nav.replaceChildren(...this.entries.map((e) => e.link));
    this.markCurrent();
    return this.entries.length >= MIN_HEADINGS;
  }

  private markCurrent() {
    if (!this.entries.length) return;
    const readingLine = this.scroller.getBoundingClientRect().top + READING_LINE_OFFSET;
    const atEnd = this.scroller.scrollTop + this.scroller.clientHeight >= this.scroller.scrollHeight - 2;
    let current = this.entries[0];
    if (atEnd) current = this.entries[this.entries.length - 1];
    else for (const entry of this.entries) {
      if (entry.heading.getBoundingClientRect().top > readingLine) break;
      current = entry;
    }
    if (current === this.current) return;
    this.current?.link.classList.remove("current");
    current.link.classList.add("current");
    this.current = current;
    this.keepVisible(current.link);
  }

  // scrollIntoView would also scroll the sidebar, which hides its overflow but still scrolls.
  private keepVisible(link: HTMLElement) {
    const view = this.nav.getBoundingClientRect();
    const box = link.getBoundingClientRect();
    if (box.top < view.top) this.nav.scrollTop -= view.top - box.top;
    else if (box.bottom > view.bottom) this.nav.scrollTop += box.bottom - view.bottom;
  }
}
