import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

const themeHighlight = HighlightStyle.define([
  { tag: tags.heading, color: "var(--syntax-keyword)", fontWeight: "bold" },
  { tag: [tags.emphasis], fontStyle: "italic" },
  { tag: [tags.strong], fontWeight: "bold" },
  { tag: [tags.link, tags.url], color: "var(--syntax-function)" },
  { tag: [tags.monospace, tags.string], color: "var(--syntax-string)" },
  { tag: [tags.keyword, tags.processingInstruction], color: "var(--syntax-keyword)" },
  { tag: [tags.comment, tags.quote], color: "var(--syntax-comment)", fontStyle: "var(--syntax-comment-style, italic)" },
  { tag: [tags.number, tags.bool, tags.atom], color: "var(--syntax-number)" },
  { tag: [tags.typeName, tags.className], color: "var(--syntax-type)" },
  { tag: [tags.function(tags.variableName), tags.propertyName], color: "var(--syntax-function)" },
  { tag: [tags.meta, tags.contentSeparator], color: "var(--muted)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", color: "var(--text)", backgroundColor: "var(--bg)" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", fontSize: "var(--code-size)", lineHeight: "1.6" },
  ".cm-content": { caretColor: "var(--text)", padding: "24px 0" },
  ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--muted)", border: "none" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--hover)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--selection) !important" },
  ".cm-cursor": { borderLeftColor: "var(--text)" },
});

export class SourceEditor {
  private readonly view: EditorView;

  constructor(parent: HTMLElement, private readonly onChange: (text: string) => void) {
    this.view = new EditorView({ parent, state: this.createState("") });
  }

  get text(): string {
    return this.view.state.doc.toString();
  }

  replaceDocument(text: string) {
    this.view.setState(this.createState(text));
  }

  focus() {
    this.view.focus();
  }

  private createState(doc: string) {
    return EditorState.create({
      doc,
      extensions: [
        basicSetup,
        markdown({ codeLanguages: languages }),
        syntaxHighlighting(themeHighlight),
        theme,
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) this.onChange(update.state.doc.toString());
        }),
      ],
    });
  }
}
