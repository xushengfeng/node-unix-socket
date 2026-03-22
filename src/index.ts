import { EventEmitter } from "node:events";

// 加载原生模块 - 使用动态导入以兼容 CJS 和 ESM
const native = require("../index.node");

interface NativeModule {
	USocketWrap: () => any;
	USocketWrap_connect: (wrap: any, path: string) => number;
	USocketWrap_adopt: (wrap: any, fd: number) => number;
	USocketWrap_write: (wrap: any, data?: Buffer, fds?: number[]) => number;
	USocketWrap_read: (wrap: any, size: number, copy?: boolean) => Buffer;
	USocketWrap_read_with_fds: (
		wrap: any,
		size: number,
		copy?: boolean,
	) => { data: Buffer | null; fds: number[] };
	USocketWrap_on_readable: (wrap: any, callback: () => void) => void;
	USocketWrap_on_end: (wrap: any, callback: () => void) => void;
	USocketWrap_start_reading: (wrap: any) => void;
	USocketWrap_stop_reading: (wrap: any) => void;
	USocketWrap_shutdown: (wrap: any) => void;
	USocketWrap_close: (wrap: any) => void;
	UServerWrap: () => any;
	UServerWrap_listen: (wrap: any, path: string, backlog: number) => number;
	UServerWrap_accept: (wrap: any) => number | null;
	UServerWrap_on_connection: (
		wrap: any,
		callback: (fd: number) => void,
	) => void;
	UServerWrap_start_accepting: (wrap: any) => void;
	UServerWrap_stop_accepting: (wrap: any) => void;
	UServerWrap_close: (wrap: any) => void;
}

const nativeModule = native as NativeModule;

export interface USocketOptions {
	fd?: number;
	path?: string;
	/**
	 * 是否复制数据，默认为 true。
	 * 在 Electron 中必须为 true，否则会崩溃。
	 * 当前版本始终使用复制模式以确保兼容性。
	 */
	copy?: boolean;
	/**
	 * 是否允许半关闭，默认为 false
	 */
	allowHalfOpen?: boolean;
}

export interface USocketWriteChunk {
	data?: Buffer;
	fds?: number[];
	callback?: () => void;
}

export interface ReadWithFdsResult {
	data: Buffer | null;
	fds: number[];
}

export class USocket extends EventEmitter {
	fd?: number;
	private _wrap: any = null;
	private _copy: boolean = true;
	private _allowHalfOpen: boolean = false;
	private _ended: boolean = false;
	private _closed: boolean = false;
	private _fds: number[] = [];

	constructor(opts?: USocketOptions | string) {
		super();
		if (typeof opts === "string") {
			opts = { path: opts };
		}
		if (opts?.copy !== undefined) {
			this._copy = opts.copy;
		}
		if (opts?.allowHalfOpen !== undefined) {
			this._allowHalfOpen = opts.allowHalfOpen;
		}
		if (opts?.fd || opts?.path) {
			this.connect(opts);
		}
	}

	connect(opts: USocketOptions | string, cb?: () => void): void {
		if (this._wrap) {
			throw new Error("connect on already connected USocket");
		}
		if (typeof opts === "string") {
			opts = { path: opts };
		}
		if (opts.copy !== undefined) {
			this._copy = opts.copy;
		}
		if (opts.allowHalfOpen !== undefined) {
			this._allowHalfOpen = opts.allowHalfOpen;
		}

		if (typeof cb === "function") {
			this.once("connect", cb);
		}

		this._wrap = nativeModule.USocketWrap();
		this._ended = false;
		this._closed = false;
		this._fds = [];

		// 设置 Rust 事件回调 - 使用包装函数以便重新设置
		const setupReadableCallback = () => {
			nativeModule.USocketWrap_on_readable(this._wrap, () => {
				this.emit("readable");
				// 重新设置回调以支持多次触发
				if (!this._closed) {
					setupReadableCallback();
				}
			});
		};
		setupReadableCallback();

		nativeModule.USocketWrap_on_end(this._wrap, () => {
			this.emit("end");
			if (!this._closed) {
				this.close();
			}
		});

		if (typeof opts.fd === "number") {
			const result = nativeModule.USocketWrap_adopt(this._wrap, opts.fd);
			this.fd = result >= 0 ? result : undefined;
			if (this.fd !== undefined) {
				this.emit("connect");
				nativeModule.USocketWrap_start_reading(this._wrap);
			}
		} else if (typeof opts.path === "string") {
			const result = nativeModule.USocketWrap_connect(this._wrap, opts.path);
			this.fd = result >= 0 ? result : undefined;
			if (this.fd !== undefined) {
				this.emit("connect");
				nativeModule.USocketWrap_start_reading(this._wrap);
			}
		}
	}

	/**
	 * 手动启动读取事件监听（用于 accept 后的 socket）
	 */
	startReading(): void {
		if (!this._wrap) return;

		// 设置 Rust 事件回调 - 使用包装函数以便重新设置
		const setupReadableCallback = () => {
			nativeModule.USocketWrap_on_readable(this._wrap, () => {
				this.emit("readable");
				// 重新设置回调以支持多次触发
				if (!this._closed) {
					setupReadableCallback();
				}
			});
		};
		setupReadableCallback();

		nativeModule.USocketWrap_on_end(this._wrap, () => {
			this.emit("end");
			if (!this._closed) {
				this.close();
			}
		});

		nativeModule.USocketWrap_start_reading(this._wrap);
	}

	write(
		data: Buffer | string | USocketWriteChunk | number[],
		encoding?: string | null,
		cb?: (err?: Error) => void,
	): boolean {
		if (!this._wrap) {
			throw new Error("USocket not connected");
		}

		let buf: Buffer | undefined;
		let fds: number[] | undefined;
		let callback: (() => void) | undefined;

		// 处理不同的参数格式
		if (typeof data === "string") {
			buf = Buffer.from(data, encoding as BufferEncoding);
		} else if (Buffer.isBuffer(data)) {
			buf = data;
		} else if (Array.isArray(data)) {
			fds = data;
		} else if (typeof data === "object") {
			// USocketWriteChunk 格式
			buf = data.data;
			fds = data.fds;
			callback = data.callback;
			if (typeof encoding === "function") {
				cb = encoding;
			}
		}

		if (typeof encoding === "function") {
			cb = encoding;
		}

		try {
			const written = nativeModule.USocketWrap_write(this._wrap, buf, fds);
			if (callback) {
				callback();
			}
			if (cb) {
				cb();
			}
			return written > 0;
		} catch (e) {
			if (cb) {
				cb(e as Error);
			}
			return false;
		}
	}

	/**
	 * 读取数据
	 * @param size - 要读取的最大字节数
	 */
	read(size?: number): Buffer | null;
	/**
	 * 读取数据和文件描述符
	 * @param size - 要读取的最大字节数
	 * @param fdSize - 要读取的 fd 数量，如果为 null 则读取所有缓存的 fd
	 */
	read(size: number | undefined, fdSize: number | null): ReadWithFdsResult | null;
	read(size?: number, fdSize?: number | null): Buffer | ReadWithFdsResult | null {
		if (!this._wrap) return null;

		// 如果没有 fdSize 参数，直接返回数据
		if (fdSize === undefined) {
			const data = nativeModule.USocketWrap_read(
				this._wrap,
				size || 1024,
				this._copy,
			);
			if (data && data.length > 0) {
				return data;
			}
			return null;
		}

		// 如果有 fdSize 参数，返回 { data, fds }
		if (fdSize === null) {
			fdSize = this._fds.length;
		}

		// 使用 read_with_fds 读取数据和 fds
		const result = nativeModule.USocketWrap_read_with_fds(
			this._wrap,
			size || 1024,
			this._copy,
		);

		if (result && result.fds && result.fds.length > 0) {
			this._fds = this._fds.concat(result.fds);
		}

		// 从缓存中获取 fds
		if (this._fds.length < fdSize) {
			return null;
		}

		const fds = this._fds.splice(0, fdSize);
		return { data: result.data, fds };
	}

	/**
	 * 将 fd 放回缓存
	 */
	unshift(chunk: Buffer | null, fds?: number[]): void {
		if (Array.isArray(fds)) {
			while (fds.length > 0) {
				this._fds.unshift(fds.pop()!);
			}
		}
	}

	/**
	 * 关闭写入端
	 */
	end(data?: string | Buffer, encoding?: string, cb?: () => void): this {
		if (this._ended) return this;

		if (typeof data === "string") {
			this.write(data, encoding);
		} else if (Buffer.isBuffer(data)) {
			this.write(data);
		}

		if (typeof encoding === "function") {
			cb = encoding;
		}

		if (typeof cb === "function") {
			this.once("finish", cb);
		}

		this._ended = true;
		this.shutdown();
		this.emit("finish");
		this._checkClosed();

		return this;
	}

	shutdown(): void {
		if (!this._wrap) return;
		nativeModule.USocketWrap_stop_reading(this._wrap);
		nativeModule.USocketWrap_shutdown(this._wrap);
		this.emit("end");
		this._checkClosed();
	}

	close(): void {
		if (!this._wrap) return;
		nativeModule.USocketWrap_stop_reading(this._wrap);
		nativeModule.USocketWrap_close(this._wrap);
		this._wrap = null;
		this._closed = true;
		this.emit("close");
	}

	destroy(error?: Error): this {
		if (error) {
			this.emit("error", error);
		}
		this.close();
		return this;
	}

	private _checkClosed(): void {
		if (this._ended && !this._closed) {
			// 延迟关闭以确保所有事件都被处理
			setImmediate(() => {
				if (!this._closed) {
					this.close();
				}
			});
		}
	}
}

export class UServer extends EventEmitter {
	fd?: number;
	listening: boolean = false;
	paused: boolean = false;
	private _wrap: any = null;

	constructor() {
		super();
	}

	listen(path: string, backlog?: number, cb?: () => void): void;
	listen(path: string, cb?: () => void): void;
	listen(path: { path: string; backlog?: number }, cb?: () => void): void;
	listen(path: any, backlog?: any, cb?: any): void {
		if (this._wrap || this.listening) {
			throw new Error("listen on already listened UServer");
		}
		if (typeof path === "object") {
			backlog = path.backlog;
			path = path.path;
			cb = backlog;
		} else if (typeof backlog === "function") {
			cb = backlog;
			backlog = 0;
		}
		backlog = backlog || 16;
		if (typeof path !== "string") {
			throw new Error("UServer expects valid path");
		}
		if (typeof cb === "function") {
			this.once("listening", cb);
		}
		this._wrap = nativeModule.UServerWrap();

		// 设置 Rust 事件回调
		nativeModule.UServerWrap_on_connection(this._wrap, (fd: number) => {
			const socket = new USocket({ fd });
			socket.startReading();
			this.emit("connection", socket);
		});

		const result = nativeModule.UServerWrap_listen(this._wrap, path, backlog);
		this.fd = result >= 0 ? result : undefined;
		this.listening = true;
		this.emit("listening");
		if (!this.paused) {
			this.resume();
		}
	}

	accept(): USocket | null {
		if (!this._wrap) return null;
		const fd = nativeModule.UServerWrap_accept(this._wrap);
		if (fd === null) return null;
		const socket = new USocket({ fd });
		socket.startReading();
		this.emit("connection", socket);
		return socket;
	}

	pause(): void {
		this.paused = true;
		if (this._wrap) {
			nativeModule.UServerWrap_stop_accepting(this._wrap);
		}
	}

	resume(): void {
		this.paused = false;
		if (this._wrap) {
			nativeModule.UServerWrap_start_accepting(this._wrap);
		}
	}

	close(): void {
		if (this._wrap) {
			nativeModule.UServerWrap_stop_accepting(this._wrap);
			nativeModule.UServerWrap_close(this._wrap);
			this._wrap = null;
		}
		this.listening = false;
		this.emit("close");
	}
}

export default {
	USocket,
	UServer,
};
