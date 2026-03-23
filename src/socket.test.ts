import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { UServer, USocket } from "./index";

describe("Unix Socket Module", () => {
	const testSocketDir = "/tmp/usocket-tests";

	if (!fs.existsSync(testSocketDir)) {
		fs.mkdirSync(testSocketDir, { recursive: true });
	}

	function cleanup(socketPath: string) {
		try {
			fs.unlinkSync(socketPath);
		} catch {}
	}

	function wait(ms: number) {
		return new Promise((r) => setTimeout(r, ms));
	}

	async function waitForConnection(server: UServer): Promise<USocket> {
		server.resume();
		return new Promise((resolve) => {
			server.on("connection", resolve);
		});
	}

	async function waitForData(socket: USocket): Promise<Buffer> {
		return new Promise((resolve) => {
			socket.on("data", resolve);
		});
	}

	describe("USocket", () => {
		it("should create a new instance without arguments", () => {
			const socket = new USocket();
			expect(socket).toBeDefined();
			expect(socket.fd).toBeUndefined();
		});

		it("should call write callback with error when not connected", async () => {
			const socket = new USocket();
			const error = await new Promise<Error | null | undefined>((resolve) => {
				socket.write(Buffer.from("test"), resolve);
			});
			expect(error).toBeDefined();
			expect(error?.message).toBe("USocket not connected");
		});

		it("should connect to a server", () => {
			const socketPath = path.join(testSocketDir, "client-connect");
			cleanup(socketPath);

			const server = new UServer();
			server.listen(socketPath);

			const client = new USocket(socketPath);
			expect(client.fd).toBeDefined();

			client.destroy();
			server.close();
		});

		it("should emit connect event", async () => {
			const socketPath = path.join(testSocketDir, "client-connect-event");
			cleanup(socketPath);

			const server = new UServer();
			server.listen(socketPath);

			await new Promise<void>((resolve) => {
				const client = new USocket();
				client.on("connect", () => {
					client.destroy();
					server.close();
					resolve();
				});
				client.connect(socketPath);
			});
		});

		it("should call connect callback", async () => {
			const socketPath = path.join(testSocketDir, "client-connect-cb");
			cleanup(socketPath);

			const server = new UServer();
			server.listen(socketPath);

			await new Promise<void>((resolve) => {
				const client = new USocket();
				client.connect(socketPath, () => {
					client.destroy();
					server.close();
					resolve();
				});
			});
		});

		it("should throw error when connecting twice", () => {
			const socketPath = path.join(testSocketDir, "client-twice");
			cleanup(socketPath);

			const server = new UServer();
			server.listen(socketPath);

			const client = new USocket(socketPath);
			expect(() => client.connect(socketPath)).toThrow(
				"connect on already connected USocket",
			);

			client.destroy();
			server.close();
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
			const socketPath = path.join(testSocketDir, "server-listen");
			cleanup(socketPath);

			const server = new UServer();
			server.listen(socketPath);

			expect(server.listening).toBe(true);
			expect(server.fd).toBeDefined();

			server.close();
		});

		it("should emit listening event", () => {
			const socketPath = path.join(testSocketDir, "server-event");
			cleanup(socketPath);

			const server = new UServer();
			let eventEmitted = false;
			server.on("listening", () => {
				eventEmitted = true;
			});
			server.listen(socketPath);

			expect(eventEmitted).toBe(true);

			server.close();
		});

		it("should listen with callback", () => {
			const socketPath = path.join(testSocketDir, "server-cb");
			cleanup(socketPath);

			const server = new UServer();
			let callbackCalled = false;
			server.listen(socketPath, () => {
				callbackCalled = true;
			});

			expect(callbackCalled).toBe(true);
			expect(server.listening).toBe(true);

			server.close();
		});

		it("should listen with backlog and callback", () => {
			const socketPath = path.join(testSocketDir, "server-backlog-cb");
			cleanup(socketPath);

			const server = new UServer();
			let callbackCalled = false;
			server.listen(socketPath, 32, () => {
				callbackCalled = true;
			});

			expect(callbackCalled).toBe(true);
			expect(server.listening).toBe(true);

			server.close();
		});

		it("should throw error when listening twice", () => {
			const socketPath1 = path.join(testSocketDir, "server-twice-1");
			const socketPath2 = path.join(testSocketDir, "server-twice-2");
			cleanup(socketPath1);
			cleanup(socketPath2);

			const server = new UServer();
			server.listen(socketPath1);

			expect(() => server.listen(socketPath2)).toThrow(
				"listen on already listened UServer",
			);

			server.close();
		});

		it("should handle pause and resume", () => {
			const socketPath = path.join(testSocketDir, "server-pause");
			cleanup(socketPath);

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

		it("should accept a connection", async () => {
			const socketPath = path.join(testSocketDir, "server-accept");
			cleanup(socketPath);

			const server = new UServer();
			server.listen(socketPath);

			const connectionPromise = waitForConnection(server);
			const client = new USocket(socketPath);

			const acceptedSocket = await Promise.race([
				connectionPromise,
				wait(1000).then(() => null),
			]);

			expect(acceptedSocket).not.toBeNull();
			expect(acceptedSocket!.fd).toBeDefined();

			client.destroy();
			acceptedSocket!.destroy();
			server.close();
		});
	});

	describe("Data Transfer", () => {
		it("should write data from client to server", async () => {
			const socketPath = path.join(testSocketDir, "transfer-write");
			cleanup(socketPath);

			const server = new UServer();
			server.listen(socketPath);

			const serverSocketPromise = waitForConnection(server);
			const client = new USocket(socketPath);
			const serverSocket = await serverSocketPromise;

			const dataPromise = waitForData(serverSocket);
			client.write(Buffer.from("Hello, Server!"));

			const receivedData = await Promise.race([
				dataPromise,
				wait(1000).then(() => null),
			]);

			expect(receivedData).not.toBeNull();
			expect(receivedData!.toString()).toBe("Hello, Server!");

			client.destroy();
			serverSocket.destroy();
			server.close();
		});

		it("should send multiple messages from client to server", async () => {
			const socketPath = path.join(testSocketDir, "transfer-multi-client");
			cleanup(socketPath);

			const server = new UServer();
			server.listen(socketPath);

			const serverSocketPromise = waitForConnection(server);
			const client = new USocket(socketPath);
			const serverSocket = await serverSocketPromise;

			let received = "";
			serverSocket.on("data", (data: Buffer) => (received += data.toString()));

			// 发送多条带随机数的消息
			const msg1 = `msg1-${Math.random().toString(36).slice(2)}`;
			const msg2 = `msg2-${Math.random().toString(36).slice(2)}`;
			const msg3 = `msg3-${Math.random().toString(36).slice(2)}`;

			client.write(Buffer.from(msg1));
			client.write(Buffer.from(msg2));
			client.write(Buffer.from(msg3));

			// 等待数据到达
			while (received.length < (msg1 + msg2 + msg3).length) {
				await wait(10);
			}

			// 严格验证拼接后的结果
			expect(received).toBe(msg1 + msg2 + msg3);

			client.destroy();
			serverSocket.destroy();
			server.close();
		});

		it("should send multiple messages from server to client", async () => {
			const socketPath = path.join(testSocketDir, "transfer-multi-server");
			cleanup(socketPath);

			const server = new UServer();
			server.listen(socketPath);

			const serverSocketPromise = waitForConnection(server);
			const client = new USocket(socketPath);
			const serverSocket = await serverSocketPromise;

			let received = "";
			client.on("data", (data: Buffer) => (received += data.toString()));

			// 服务器发送多条带随机数的消息
			const msg1 = `srv1-${Math.random().toString(36).slice(2).repeat(5)}`;
			const msg2 = `srv2-${Math.random().toString(36).slice(2).repeat(5)}`;
			const msg3 = `srv3-${Math.random().toString(36).slice(2).repeat(5)}`;

			serverSocket.write(Buffer.from(msg1));
			await wait(10);
			serverSocket.write(Buffer.from(msg2));
			await wait(10);
			serverSocket.write(Buffer.from(msg3));
			await wait(10);

			// 等待数据到达
			while (received.length < (msg1 + msg2 + msg3).length) {
				await wait(10);
			}

			// 严格验证拼接后的结果
			expect(received).toBe(msg1 + msg2 + msg3);

			client.destroy();
			serverSocket.destroy();
			server.close();
		});

		it("should handle bidirectional communication", async () => {
			const socketPath = path.join(testSocketDir, "transfer-bidirectional");
			cleanup(socketPath);

			const server = new UServer();
			server.listen(socketPath);

			const serverSocketPromise = waitForConnection(server);
			const client = new USocket(socketPath);
			const serverSocket = await serverSocketPromise;

			// 客户端 -> 服务器
			const serverDataPromise = waitForData(serverSocket);
			const clientMsg = `client-${Math.random().toString(36).slice(2)}`;
			client.write(Buffer.from(clientMsg));
			const receivedByServer = await Promise.race([
				serverDataPromise,
				wait(1000).then(() => null),
			]);

			expect(receivedByServer).not.toBeNull();
			expect(receivedByServer!.toString()).toBe(clientMsg);

			// 服务器 -> 客户端
			const clientDataPromise = waitForData(client);
			const serverMsg = `server-${Math.random().toString(36).slice(2)}`;
			serverSocket.write(Buffer.from(serverMsg));
			const receivedByClient = await Promise.race([
				clientDataPromise,
				wait(1000).then(() => null),
			]);

			expect(receivedByClient).not.toBeNull();
			expect(receivedByClient!.toString()).toBe(serverMsg);

			client.destroy();
			serverSocket.destroy();
			server.close();
		});

		it("should handle round-trip counter", async () => {
			const socketPath = path.join(testSocketDir, "transfer-counter");
			cleanup(socketPath);

			const server = new UServer();
			server.listen(socketPath);

			const serverSocketPromise = waitForConnection(server);
			const client = new USocket(socketPath);
			const serverSocket = await serverSocketPromise;

			const maxCount = 10;
			let lastServerReceived = -1;
			let lastClientReceived = -1;

			// 服务器收到 N 后回复 N+1
			serverSocket.on("data", (data: Buffer) => {
				const n = parseInt(data.toString());
				lastServerReceived = n;
				if (n < maxCount) {
					serverSocket.write(Buffer.from(String(n + 1)));
				}
			});

			// 客户端收到 N 后发送 N+1
			client.on("data", (data: Buffer) => {
				const n = parseInt(data.toString());
				lastClientReceived = n;
				if (n < maxCount) {
					client.write(Buffer.from(String(n + 1)));
				}
			});

			// 开始：客户端发送 0
			client.write(Buffer.from("0"));

			// 等待完成
			const startTime = Date.now();
			while (lastServerReceived < maxCount && Date.now() - startTime < 1000) {
				await wait(10);
			}

			// 验证计数器正确累加
			// 服务器收到 10 后停止回复，客户端收到 9
			expect(lastServerReceived).toBe(maxCount);
			expect(lastClientReceived).toBe(maxCount - 1);

			client.destroy();
			serverSocket.destroy();
			server.close();
		});

		it("should handle bidirectional counter", async () => {
			const socketPath = path.join(testSocketDir, "transfer-bidi-counter");
			cleanup(socketPath);

			const server = new UServer();
			server.listen(socketPath);

			const serverSocketPromise = waitForConnection(server);
			const client = new USocket(socketPath);
			const serverSocket = await serverSocketPromise;

			const maxCount = 10;
			const counts: number[] = [];

			// 服务器收到数字后累加并回复自己的累加值
			serverSocket.on("data", (data: Buffer) => {
				const n = parseInt(data.toString());
				counts.push(n);
				if (n < maxCount) serverSocket.write(Buffer.from(String(n + 1)));
			});

			// 客户端收到数字后累加并发送新数字
			client.on("data", (data: Buffer) => {
				const n = parseInt(data.toString());
				counts.push(n);
				if (n < maxCount) {
					client.write(Buffer.from(String(n + 1)));
				}
			});

			client.write(Buffer.from(String(1)));
			await wait(20);

			await wait(100);

			expect(counts).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

			client.destroy();
			serverSocket.destroy();
			server.close();
		});

		it("should handle interleaved sends", async () => {
			const socketPath = path.join(testSocketDir, "transfer-interleaved");
			cleanup(socketPath);

			const server = new UServer();
			server.listen(socketPath);

			const serverSocketPromise = waitForConnection(server);
			const client = new USocket(socketPath);
			const serverSocket = await serverSocketPromise;

			let serverReceived = "";
			let clientReceived = "";

			serverSocket.on(
				"data",
				(data: Buffer) => (serverReceived += data.toString()),
			);
			client.on("data", (data: Buffer) => (clientReceived += data.toString()));

			// 交替发送带随机数的消息
			const c1 = `c1-${Math.random().toString(36).slice(2, 6)}`;
			const s1 = `s1-${Math.random().toString(36).slice(2, 6)}`;
			const c2 = `c2-${Math.random().toString(36).slice(2, 6)}`;
			const s2 = `s2-${Math.random().toString(36).slice(2, 6)}`;

			client.write(Buffer.from(c1));
			serverSocket.write(Buffer.from(s1));
			client.write(Buffer.from(c2));
			serverSocket.write(Buffer.from(s2));

			// 等待数据到达
			const expectedServer = c1 + c2;
			const expectedClient = s1 + s2;
			while (
				serverReceived.length < expectedServer.length ||
				clientReceived.length < expectedClient.length
			) {
				await wait(10);
			}

			// 严格验证拼接后的结果
			expect(serverReceived).toBe(expectedServer);
			expect(clientReceived).toBe(expectedClient);

			client.destroy();
			serverSocket.destroy();
			server.close();
		});

		it("should handle large data transfer", async () => {
			const socketPath = path.join(testSocketDir, "transfer-large");
			cleanup(socketPath);

			const server = new UServer();
			server.listen(socketPath);

			const serverSocketPromise = waitForConnection(server);
			const client = new USocket(socketPath);
			const serverSocket = await serverSocketPromise;

			// 生成 32KB 随机数据
			const largeData = Buffer.alloc(32 * 1024);
			for (let i = 0; i < largeData.length; i++) {
				largeData[i] = Math.floor(Math.random() * 256);
			}

			let received = Buffer.alloc(0);
			serverSocket.on("data", (data: Buffer) => {
				received = Buffer.concat([received, data]);
			});

			client.write(largeData);

			// 等待所有数据到达
			while (received.length < largeData.length) {
				await wait(10);
			}

			// 严格验证数据完全一致
			expect(received.length).toBe(largeData.length);
			expect(received.equals(largeData)).toBe(true);

			client.destroy();
			serverSocket.destroy();
			server.close();
		});
	});

	describe("Events", () => {
		it("should emit close event", () => {
			const socketPath = path.join(testSocketDir, "event-close");
			cleanup(socketPath);

			const server = new UServer();
			server.listen(socketPath);

			let closeEmitted = false;
			server.on("close", () => {
				closeEmitted = true;
			});
			server.close();

			expect(closeEmitted).toBe(true);
		});

		it("should emit finish event on end", async () => {
			const socketPath = path.join(testSocketDir, "event-finish");
			cleanup(socketPath);

			const server = new UServer();
			server.listen(socketPath);

			const serverSocketPromise = waitForConnection(server);
			const client = new USocket(socketPath);
			await serverSocketPromise;

			const finishPromise = new Promise<void>((resolve) => {
				client.on("finish", resolve);
			});

			client.end();

			await Promise.race([
				finishPromise,
				wait(1000).then(() => {
					throw new Error("Timeout");
				}),
			]);

			client.destroy();
			server.close();
		});

		it("should emit data event when data arrives", async () => {
			const socketPath = path.join(testSocketDir, "event-data");
			cleanup(socketPath);

			const server = new UServer();
			server.listen(socketPath);

			const serverSocketPromise = waitForConnection(server);
			const client = new USocket(socketPath);
			const serverSocket = await serverSocketPromise;

			const dataPromise = waitForData(serverSocket);
			client.write(Buffer.from("Hello data!"));

			const receivedData = await Promise.race([
				dataPromise,
				wait(1000).then(() => null),
			]);

			expect(receivedData).not.toBeNull();
			expect(receivedData!.toString()).toBe("Hello data!");

			client.destroy();
			serverSocket.destroy();
			server.close();
		});

		it("should handle multiple rounds of conversation", async () => {
			const socketPath = path.join(testSocketDir, "event-multi-round");
			cleanup(socketPath);

			const server = new UServer();
			server.listen(socketPath);

			const serverSocketPromise = waitForConnection(server);
			const client = new USocket(socketPath);
			const serverSocket = await serverSocketPromise;

			let serverReceived = "";
			let clientReceived = "";

			serverSocket.on("data", (data) => (serverReceived += data.toString()));
			client.on("data", (data) => (clientReceived += data.toString()));

			// 发送带随机数的消息
			const clientMsg1 = `c1-${Math.random().toString(36).slice(2, 8)}`;
			const serverMsg1 = `s1-${Math.random().toString(36).slice(2, 8)}`;
			const clientMsg2 = `c2-${Math.random().toString(36).slice(2, 8)}`;
			const serverMsg2 = `s2-${Math.random().toString(36).slice(2, 8)}`;

			client.write(Buffer.from(clientMsg1));
			serverSocket.write(Buffer.from(serverMsg1));
			client.write(Buffer.from(clientMsg2));
			serverSocket.write(Buffer.from(serverMsg2));

			// 等待所有数据到达
			const expectedServer = clientMsg1 + clientMsg2;
			const expectedClient = serverMsg1 + serverMsg2;
			while (
				serverReceived.length < expectedServer.length ||
				clientReceived.length < expectedClient.length
			) {
				await wait(10);
			}

			// 严格验证拼接后的结果
			expect(serverReceived).toBe(expectedServer);
			expect(clientReceived).toBe(expectedClient);

			client.destroy();
			serverSocket.destroy();
			server.close();
		});
	});
	describe("other test", () => {
		it("case1", async () => {
			const socketPath = path.join(testSocketDir, "other-case1");
			cleanup(socketPath);

			const server = new UServer();
			server.listen(socketPath);

			const serverSocketPromise = waitForConnection(server);
			const client = new USocket(socketPath);
			const serverSocket = await serverSocketPromise;

			const m = Array.from({ length: 4 })
				.fill(0)
				.map((_) => Math.random().toString(36).slice(2, 8));
			const re = [...m];
			serverSocket.on("data", (data) => {
				const str = data
					.toString()
					.split(",")
					.filter((s) => s);
				for (const s of str) {
					const num = parseInt(s);
					if (num === 4 || num === 10 || num === 13 || num === 25) {
						console.log("w");
						serverSocket.write(Buffer.from(m.shift()!));
					}
				}
			});
			const received: string[] = [];
			client.on("data", (data) => {
				const str = data.toString();
				received.push(str);
			});
			for (let i = 1; i <= 25; i++) {
				client.write(Buffer.from(String(i) + ","));
				// await wait(10);
			}
			await wait(500);
			expect(received).toEqual(re);

			client.destroy();
			serverSocket.destroy();
			server.close();
		});
	});
});
