# export

Writes a document to one standalone file: a PDF, a Markdown file or an HTML page. Pictures are
inside the file and formulas are typeset. `export::write(&Document, Format, &Path)` is the whole
interface.

This crate began as a copy of the `export` crate of Quanty (`github.com/coderaidershaun/quanty`)
at commit `abc355e`, trimmed of what only Quanty uses. It has no dependency on Quanty and is
Jet's own from here on. The fonts in `assets/fonts` are under the SIL Open Font License; see the
`*-OFL.txt` files there.
