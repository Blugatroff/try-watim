export const STDIN = 0
export const STDOUT = 1
export const STDERR = 2

const NOT_SUPPORTED = 58
const IS_A_DIRECTORY = 31
const NO_SUCH_FILE_OR_DIRECTORY = 44

export type FileEntry<T> = {
    type: "file",
    file: T
}

export type Directory<T> = {
    type: "directory",
    children: Record<string, FileSystemNode<T>>
}

export const mapFileEntry = <A, B>(f: (a: A) => B) => (file: FileEntry<A>): FileEntry<B> => {
    return {
        ...file,
        file: f(file.file)
    }
}

export const mapDirectory = <A, B>(f: (a: A) => B) => (dir: Directory<A>): Directory<B> => {
    const map = mapFileSystemNode(f)
    return {
        ...dir,
        children: Object.fromEntries(Object.entries(dir.children).map(([k, v]) => [k, map(v)]))
    }
}

export const mapFileSystemNode = <A, B>(f: (a: A) => B) => (entry: FileSystemNode<A>): FileSystemNode<B> =>
    entry.type === "file" ? mapFileEntry(f)(entry) : mapDirectory(f)(entry)

export type FileSystemNode<T> = FileEntry<T> | Directory<T>

export type FileLoader = (path: string) => Promise<string>
type File = {
    read: (ptr: number, len: number) => [number, number],
    write: (data: DataView) => [number, number],
    prestatName?: string
}

export const prepareWasi = (
    wasmPath: string,
    argStrings: string[],
    fs: FileSystemNode<FileLoader>,
    writeOutput: (v: { fd: number, data: string }) => void,
    onExit?: (code: number) => void
) => async (getMemory: () => DataView): Promise<WebAssembly.Imports> => {
    const args: DataView[] = [
        wasmPath,
        ...argStrings,
    ].map(s => new DataView(new TextEncoder().encode(s).buffer))

    const createFile = (data: DataView): File => {
        let cursor = 0
        return {
            read(ptr: number, len: number) {
                const memory = getMemory()
                const read = copy(data, memory, cursor, ptr, len)
                cursor += read
                return [read, 0]
            },
            write: () => [0, NOT_SUPPORTED]
        }
    }

    const loadFileSystem = async (path: string, fileSystem: FileSystemNode<FileLoader>): Promise<FileSystemNode<File>> => {
        if (fileSystem.type === "file") {
            const text = await fileSystem.file(path)
            const file = createFile(new DataView(new TextEncoder().encode(text).buffer))
            return {
                type: "file",
                file
            }
        }
        const children = Object.entries(fileSystem.children).map(async ([childPath, node]): Promise<[string, FileSystemNode<File>]> => {
            return [childPath, await loadFileSystem(`${path}/${childPath}`, node)]
        })
        return {
            type: "directory",
            children: Object.fromEntries(await Promise.all(children))
        }
    }

    const fileSystem: FileSystemNode<File> = {
        type: "directory",
        children: {
            ".": await loadFileSystem(".", fs)
        }
    }
    const nextFd = (() => {
        let i = 0
        return () => i++
    })()
    const readNotSupported = (_ptr: number, _len: number): [number, number] => [0, NOT_SUPPORTED]
    const writeNotSupported = (_data: DataView): [number, number] => [0, NOT_SUPPORTED]
    const openFds: Record<number, File> = {
        [nextFd()]: {
            write: writeNotSupported,
            read: readNotSupported,
        },
        [nextFd()]: {
            write(data: DataView) {
                const dataStr = new TextDecoder().decode(data)
                writeOutput({ fd: STDOUT, data: dataStr })
                return [data.byteLength, 0]
            },
            read: readNotSupported
        },
        [nextFd()]: {
            write(data: DataView) {
                const dataStr = new TextDecoder().decode(data)
                writeOutput({ fd: STDERR, data: dataStr })
                return [data.byteLength, 0]
            },
            read: readNotSupported
        },
        [nextFd()]: {
            read: readNotSupported,
            write: writeNotSupported,
            prestatName: ".",
        }
    }

    const openFile = (path: string, fileSystem: FileSystemNode<File>): [number, number] => {
        let splits = path.length === 0 ? [] : path.split('/')
        if (splits.length === 0) {
            if (fileSystem.type === "directory") return [0, IS_A_DIRECTORY]
            const fd = nextFd()
            openFds[fd] = fileSystem.file
            return [fd, 0]
        }
        if (fileSystem.type !== "directory") return [0, NO_SUCH_FILE_OR_DIRECTORY]
        const entry = fileSystem.children[splits[0]]
        if (entry === undefined) return [0, NO_SUCH_FILE_OR_DIRECTORY]
        return openFile(splits.slice(1).join('/'), entry)
    }

    const copy = (srcBuf: DataView, dstBuf: DataView, src: number, dst: number, len: number) => {
        for (let i = 0; i < len; i++) {
            if (src + i >= srcBuf.byteLength) return i
            if (dst + i >= dstBuf.byteLength) return i
            dstBuf.setUint8(dst + i, srcBuf.getUint8(src + i))
        }
        return len
    }

    const fd_read = (fd: number, iovsPtr: number, iovsLen: number, readPtr: number) => {
        const memory = getMemory()
        const readFn = openFds[fd]?.read
        if (readFn === undefined) {
            throw new Error(`file descriptor ${fd} is not open`)
        }
        let read = 0
        for (let i = 0; i < iovsLen; i++) {
            const iovPtr = iovsPtr + 8 * i
            const ptr = memory.getUint32(iovPtr, true)
            const len = memory.getUint32(iovPtr + 4, true)
            const [readThisTime, code] = readFn(ptr, len)
            if (code !== 0) return code
            read += readThisTime
            if (readThisTime < len) break
        }
        memory.setUint32(readPtr, read, true)
        return 0
    }

    const fd_write = (fd: number, iovsPtr: number, iovsLen: number, writtenPtr: number) => {
        const memory = getMemory()
        let written = 0
        const writeFn = openFds[fd]?.write
        if (writeFn === undefined) {
            throw new Error(`file descriptor ${fd} is not open`)
        }
        for (let i = 0; i < iovsLen; i++) {
            const iovPtr = iovsPtr + 8 * i
            const ptr = memory.getUint32(iovPtr, true)
            const len = memory.getUint32(iovPtr + 4, true)
            const data = memory.buffer.slice(ptr, ptr + len)
            const [writ, code] = writeFn(new DataView(data))
            if (code !== 0) return code
            written += writ
        }
        memory.setUint32(writtenPtr, written, true)
        return 0
    }

    const args_sizes_get = (number: number, sizePtr: number) => {
        const memory = getMemory()
        memory.setUint32(number, args.length, true)
        const size = args.map(s => s.byteLength + 1).reduce((a, b) => a + b, 0)
        memory.setUint32(sizePtr, size, true)
        return 0
    }

    const args_get = (argv: number, argv_buf: number) => {
        const memory = getMemory()
        let ptr = argv_buf
        for (let i = 0; i < args.length; i++) {
            memory.setUint32(argv + 4 * i, ptr, true)
            copy(args[i], memory, 0, ptr, args[i].byteLength)
            memory.setUint8(ptr + args[i].byteLength, 0)
            ptr += args[i].byteLength
        }
        return 0
    }

    const fd_prestat_get = (fd: number, prestat: number) => {
        const memory = getMemory()
        const file = openFds[fd]
        if (file === undefined) return 8
        if (file.prestatName === undefined) return 8
        const pathBytes = new TextEncoder().encode(file.prestatName)
        const kind = 0
        memory.setUint32(prestat, kind, true)
        memory.setUint32(prestat + 4, pathBytes.byteLength, true)
        return 0
    }

    const proc_exit = (code: number) => {
        onExit?.(code)
        throw new Error(`EXIT ${code}`)
    }

    const fd_prestat_dir_name = (fd: number, ptr: number, len: number) => {
        const memory = getMemory()
        const file = openFds[fd]
        if (file === undefined) return 8
        if (file.prestatName === undefined) return 8
        const data = new DataView(new TextEncoder().encode(file.prestatName).buffer)
        copy(data, memory, 0, ptr, len)
        return 0
    }

    const path_open = (_parentFd: number, _dirflags: number, pathPtr: number, pathLen: number, _oflags: number, _fsRightsBase: number, _fsRightsInheriting: number, _fdFlags: number, resPtr: number) => {
        const memory = getMemory()
        const path = new TextDecoder().decode(memory.buffer.slice(pathPtr, pathPtr + pathLen))
        const [fd, code] = openFile(path, fileSystem)
        memory.setUint32(resPtr, fd, true)
        return code
    }

    return {
        wasi_unstable: {
            fd_read,
            fd_write,
            proc_exit,
            args_sizes_get,
            args_get,
            fd_prestat_get,
            fd_prestat_dir_name,
            path_open,
        },
    }
}

export const runWasi = async (
    loadWasm: (imports: WebAssembly.Imports) => Promise<WebAssembly.WebAssemblyInstantiatedSource>,
    binaryPath: string,
    args: string[],
    fs: FileSystemNode<FileLoader>,
    writeOutput: (v: { fd: number, data: string }) => void,
): Promise<number | undefined> => {
    return new Promise(async resolve => {
        const wasi = prepareWasi(binaryPath, args, fs, writeOutput, resolve)
        const imports: WebAssembly.Imports = await wasi(() => getMemory())
        const { instance } = await loadWasm(imports)
        const exports = instance.exports

        const memExport = exports["memory"]
        if (!(memExport instanceof WebAssembly.Memory)) {
            resolve(undefined)
            return
        }
        const getMemory = () => new DataView(memExport.buffer)

        const startExport = exports["_start"]
        if (!(startExport instanceof Function)) {
            resolve(undefined)
            return
        }
        startExport()
        resolve(0)
    })
}

