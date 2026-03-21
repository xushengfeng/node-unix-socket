import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { UServer, USocket } from "./index";

describe("Unix Socket Module", () => {
	const testSocketDir = "/tmp/usocket-tests";

	describe("USocket", () => {
		it("should create a new instance without arguments", () => {
			const socket = new USocket();
			expect(socket).toBeDefined();
			expect(socket.fd).toBeUndefined();
		});

		it("should throw error when writing to unconnected socket", () => {
			const socket = new USocket();
			expect(() => socket.write(Buffer.from("test"))).toThrow(
				"USocket not connected",
			);
		});

		it("should return null when reading from unconnected socket", () => {
			const socket = new USocket();
			const result = socket.read(1024);
			expect(result).toBeNull();
		});

		it("should handle close on unconnected socket", () => {
			const socket = new USocket();
			expect(() => socket.close()).not.toThrow();
		});
	});

	describe("UServer", () => {
		it("should create a new instance", () => {
			const server = new UServer();
			expect(server).toBeDefined();
			expect(server.listening).toBe(false);
			expect(server.paused).toBe(false);
			expect(server.fd).toBeUndefined();
		});

		it("should listen on a socket path", () => {
			const socketPath = path.join(testSocketDir, "server-1");

			// 确保测试目录存在
			if (!fs.existsSync(testSocketDir)) {
				fs.mkdirSync(testSocketDir, { recursive: true });
			}

			// 清理可能存在的旧 socket 文件
			try {
				fs.unlinkSync(socketPath);
			} catch {
				// 忽略
			}

			const server = new UServer();
			server.listen(socketPath);

			expect(server.listening).toBe(true);
			expect(server.fd).toBeDefined();

			server.close();
		});

		it("should emit listening event", () => {
			const socketPath = path.join(testSocketDir, "server-2");

			if (!fs.existsSync(testSocketDir)) {
				fs.mkdirSync(testSocketDir, { recursive: true });
			}

			try {
				fs.unlinkSync(socketPath);
			} catch {
				// 忽略
			}

			const server = new UServer();
			let eventEmitted = false;

			server.on("listening", () => {
				eventEmitted = true;
			});

			server.listen(socketPath);

			expect(eventEmitted).toBe(true);

			server.close();
		});

		it("should throw error when listening twice", () => {
			const socketPath1 = path.join(testSocketDir, "server-3a");
			const socketPath2 = path.join(testSocketDir, "server-3b");

			if (!fs.existsSync(testSocketDir)) {
				fs.mkdirSync(testSocketDir, { recursive: true });
			}

			try {
				fs.unlinkSync(socketPath1);
			} catch {}
			try {
				fs.unlinkSync(socketPath2);
			} catch {}

			const server = new UServer();
			server.listen(socketPath1);

			expect(() => server.listen(socketPath2)).toThrow(
				"listen on already listened UServer",
			);

			server.close();
		});

		it("should return null when accepting without connections", () => {
			const socketPath = path.join(testSocketDir, "server-4");

			if (!fs.existsSync(testSocketDir)) {
				fs.mkdirSync(testSocketDir, { recursive: true });
			}

			try {
				fs.unlinkSync(socketPath);
			} catch {}

			const server = new UServer();
			server.listen(socketPath);

			const socket = server.accept();
			expect(socket).toBeNull();

			server.close();
		});

		it("should handle pause and resume", () => {
			const socketPath = path.join(testSocketDir, "server-5");

			if (!fs.existsSync(testSocketDir)) {
				fs.mkdirSync(testSocketDir, { recursive: true });
			}

			try {
				fs.unlinkSync(socketPath);
			} catch {}

			const server = new UServer();
			server.listen(socketPath);

			expect(server.paused).toBe(false);

			server.pause();
			expect(server.paused).toBe(true);

			server.resume();
			expect(server.paused).toBe(false);

			server.close();
		});

		it("should handle close on non-listening server", () => {
			const server = new UServer();
			expect(() => server.close()).not.toThrow();
		});
	});
});
