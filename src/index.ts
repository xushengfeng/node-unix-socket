import { EventEmitter } from "node:events";

// 加载原生模块 - 使用动态导入以兼容 CJS 和 ESM
const native = require("../index.node");

interface NativeModule {
	USocketWrap: () => any;
	USocketWrap_connect: (wrap: any, path: string) => number;
	USocketWrap_adopt: (wrap: any, fd: number) => number;
	USocketWrap_write: (wrap: any, data?: Buffer, fds?: number[]) => number;
	USocketWrap_read: (wrap: any, size: number) => Buffer;
	USocketWrap_read_with_fds: (
		wrap: any,
		size: number,
	) => { data: Buffer | null; fds: number[] };
	USocketWrap_shutdown: (wrap: any) => void;
	USocketWrap_close: (wrap: any) => void;
	UServerWrap: () => any;
	UServerWrap_listen: (wrap: any, path: string, backlog: number) => number;
	UServerWrap_accept: (wrap: any) => number | null;
	UServerWrap_close: (wrap: any) => void;
}

const nativeModule = native as NativeModule;

export interface USocketOptions {
	fd?: number;
	path?: string;
}

export interface USocketWriteChunk {
	data?: Buffer;
	fds?: number[];
}

export interface ReadWithFdsResult {
	data: Buffer | null;
	fds: number[];
}

export class USocket {
	fd?: number;
	private _wrap: any = null;

	constructor(opts?: USocketOptions | string) {
		if (typeof opts === "string") {
			opts = { path: opts };
		}
		if (opts?.fd || opts?.path) {
			this.connect(opts);
		}
	}

	connect(opts: USocketOptions | string): void {
		if (this._wrap) {
			throw new Error("connect on already connected USocket");
		}
		if (typeof opts === "string") {
			opts = { path: opts };
		}
		this._wrap = nativeModule.USocketWrap();
		if (typeof opts.fd === "number") {
			const result = nativeModule.USocketWrap_adopt(this._wrap, opts.fd);
			this.fd = result >= 0 ? result : undefined;
		} else if (typeof opts.path === "string") {
			const result = nativeModule.USocketWrap_connect(this._wrap, opts.path);
			this.fd = result >= 0 ? result : undefined;
		}
	}

	write(data: Buffer, fds?: number[]): number {
		if (!this._wrap) {
			throw new Error("USocket not connected");
		}
		return nativeModule.USocketWrap_write(this._wrap, data, fds);
	}

	read(size: number): Buffer | null {
		if (!this._wrap) return null;
		return nativeModule.USocketWrap_read(this._wrap, size);
	}

	readWithFds(size: number): ReadWithFdsResult | null {
		if (!this._wrap) return null;
		return nativeModule.USocketWrap_read_with_fds(this._wrap, size);
	}

	shutdown(): void {
		if (!this._wrap) return;
		nativeModule.USocketWrap_shutdown(this._wrap);
	}

	close(): void {
		if (!this._wrap) return;
		nativeModule.USocketWrap_close(this._wrap);
		this._wrap = null;
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
		return new USocket({ fd });
	}

	pause(): void {
		this.paused = true;
	}

	resume(): void {
		this.paused = false;
	}

	close(): void {
		if (!this._wrap) return;
		nativeModule.UServerWrap_close(this._wrap);
		this._wrap = null;
	}
}

export default {
	USocket,
	UServer,
};