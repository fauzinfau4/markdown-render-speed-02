[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/fauzinfau4/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/fauzinfau4/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
# Markdown renderer

This entry renders Markdown documents to HTML for the make.fun
markdown-render-speed-02 competition. Its `parse(markdown)` function is a
dependency-free CommonMark and GFM renderer implemented in `parse.js`.

## How it works

The parser reads a document as lines, recognizes block elements such as
headings, lists, tables, code blocks and HTML, and then converts inline text
such as links, code spans, emphasis and autolinks. It uses JavaScript and
Node's built-in modules only.

`main.ts` reads the ordered case array from `cases.json`, renders each
Markdown value separately, and writes the resulting HTML string array to
`html.json`.

## Run locally

With the competition layout, the driver uses `/input/cases.json` and writes
`/output/html.json`. Set the directory variables to use local folders:

```sh
MAKEFUN_INPUT_DIR=./input MAKEFUN_OUTPUT_DIR=./output node main.ts
```

To render a single string from another ES module:

```js
import { parse } from './parse.js';

console.log(parse('# A heading'));
```
