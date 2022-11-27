import './style.css'
import * as C from './compiler'

import { Compartment, EditorState } from "@codemirror/state"
import { EditorView, keymap, lineNumbers } from "@codemirror/view"
import { defaultKeymap, indentWithTab, history, historyKeymap } from "@codemirror/commands"
import Wabt from 'wabt'

export const cached = <T>(f: (i: string) => Promise<T>) => {
    const cache = new Map<string, T>()
    return async (i: string): Promise<T> => {
        const v = cache.get(i)
        if (v !== undefined) return v
        const nv = await f(i)
        cache.set(i, nv)
        return nv
    }
}
const fetchFile = cached((path: string) => fetch("." + path).then(res => res.text()))

const code = await fetchFile('./code.watim')

const theme = EditorView.baseTheme({
    "&": {
        fontSize: "16px",
        backgroundColor: "lightgrey",
        border: "1px solid #654FF0"
    },
    ".cm-gutters": {

    }
})

const editorState = EditorState.create({
    doc: code,
    extensions: [
        keymap.of(defaultKeymap),
        keymap.of([indentWithTab]),
        history({}),
        keymap.of(historyKeymap),
        EditorView.updateListener.of(e => {
            if (e.docChanged) recompile(editorView.state.doc.toString())
        }),
        new Compartment().of(lineNumbers()),
        theme
    ],
})

const mainDiv = document.createElement('div')
mainDiv.id = "main-div"
document.body.appendChild(mainDiv)

const editorView = new EditorView({
    state: editorState,
    parent: mainDiv,
})
const outerOutputDiv = document.createElement('div')
outerOutputDiv.id = "outer-output-div"
mainDiv.appendChild(outerOutputDiv)

const compile = async (files: C.FileSystemNode<string | null>) => {
    const fs = C.mapFileSystemNode((v: string | null) => (path: string) => {
        if (v === null) return fetchFile(path)
        return Promise.resolve(v)
    })(files)
    type Pre = { element: HTMLPreElement, fd: number }
    let pre: Pre | null = null

    const outputDiv = document.createElement('div')
    outputDiv.id = "output-div"
    const programOutputDiv = document.createElement('div')
    programOutputDiv.id = "output-div"

    let stdout = ""
    const writeOutput = (outputDiv: HTMLElement) => ({ fd, data }: { fd: number, data: string }) => {
        if (fd === 1) {
            stdout += data
        }
        const add = (data: string) => {
            const element: HTMLPreElement = document.createElement('pre')
            element.className = `output-line output-line-${fd}`
            element.innerHTML = data
            pre = { element, fd }
            outputDiv.appendChild(element)
        }
        if (fd !== pre?.fd) return add(data)
        const lines = data.split('\n')
        if (lines.length === 0) return
        pre.element.innerHTML += lines[0]
        for (const line of lines.slice(1)) {
            add(line)
        }
    }
    const watimCompiler: (imports: WebAssembly.Imports) => Promise<WebAssembly.WebAssemblyInstantiatedSource> = imports =>
        WebAssembly.instantiateStreaming(fetch("./watim.wasm"), imports)

    const exitCode = await C.runWasi(watimCompiler, "watim.wasm", ["./test.watim"], fs, writeOutput(outputDiv))
    if (exitCode == 0) {
        try {
            const wabt = await Wabt()
            const module = wabt.parseWat("out.wat", stdout, {
                bulk_memory: true,
            })
            const binary = module.toBinary({})
            await C.runWasi(imports => WebAssembly.instantiate(binary.buffer, imports), "test.watim", [], fs, writeOutput(programOutputDiv))
        } catch (e) {
            console.error("TEHRE", e)
        }
    }
    outerOutputDiv.innerHTML = ""
    outerOutputDiv.appendChild(programOutputDiv)
    outerOutputDiv.appendChild(outputDiv)
}

type Dir = { [key in string]: Node }
type File = string | undefined
type Node = Dir | File

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

const recompile = (code: string) => {
    const fs: Node = {
        "test.watim": code,
        "std": {
            "alloc.watim": undefined,
            "io.watim": undefined,
            "string.watim": undefined,
            "str.watim": undefined,
            "core.watim": undefined,
            "fs.watim": undefined,
            "util.watim": undefined,
            "args.watim": undefined,
            "format.watim": undefined,
            "i32vec.watim": undefined,
            "map.watim": undefined,
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
    compile(transform(fs))
}
recompile(code)
