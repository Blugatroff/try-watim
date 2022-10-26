import './style.css'
import * as C from './compiler'

import { EditorState } from "@codemirror/state"
import { EditorView, keymap } from "@codemirror/view"
import { defaultKeymap, indentWithTab, history, historyKeymap } from "@codemirror/commands"

const code = "fn main() {\n  local x: i32\n  ?x 1 + drop\n}"

const editorState = EditorState.create({
    doc: code,
    extensions: [
        keymap.of(defaultKeymap),
        keymap.of([indentWithTab]),
        history({}),
        keymap.of(historyKeymap)
    ],
})

const editorView = new EditorView({
    state: editorState,
    parent: document.body,
})

const div = document.createElement('div')
div.style.fontSize = "18px"
document.body.appendChild(div)

const compile = (files: C.FileSystemNode<string | null>) => {
    const fs = C.mapFileSystemNode((v: string | null) => (path: string) => {
        if (v === null) return fetchFile(path)
        return Promise.resolve(v)
    })(files)
    type Pre = { element: HTMLPreElement, fd: number }
    let pre: Pre | null = null

    div.innerHTML = ""
    const writeOutput = ({ fd, data }: { fd: number, data: string }) => {
        if (pre && pre.fd === fd) {
            pre.element.innerText += data
            return
        }
        const element = document.createElement('pre')
        element.style.margin = "0px"
        element.style.color = fd === 1 ? "" : "yellow"
        element.innerText = data
        pre = { element, fd }
        div.appendChild(element)
    }

    C.compile("./watim.wasm", ["./test.watim"], fs, writeOutput)
}
const fetchFile = (path: string) => fetch("." + path).then(res => res.text())

type Dir = { [key in string]: Node }
type File = string | undefined
type Node = Dir | File

const fs: Node = {
    "test.watim": code,
    "std": {
        "alloc.watim": undefined,
        "io.watim": undefined,
        "string.watim": undefined,
        "core.watim": undefined,
        "fs.watim": undefined,
        "util.watim": undefined,
        "args.watim": undefined,
        "format.watim": undefined,
        "i32vec.watim": undefined,
        "map.watim": undefined,
        "string2.watim": undefined,
    },
    "native": {
        "main.watim": undefined,
        "ast.watim": undefined,
        "lexer.watim": undefined,
        "parser.watim": undefined,
        "checker.watim": undefined,
        "util.watim": undefined,
        "resolver.watim": undefined,
        "mem.watim": undefined,
        "intrinsic.watim": undefined,
        "module.watim": undefined,
        "break_stack.watim": undefined,
        "wat_gen.watim": undefined,
    },
}

const transform = (node: Node): C.FileSystemNode<string | null> => {
    if (typeof node === "object") return {
        type: "directory",
        children: Object.fromEntries(Object.entries(node).map(
            ([k, v]) => [k, transform(v)]
        ))
    }
    return {
        type: "file",
        file: node ?? null
    }
}

compile(transform(fs))
