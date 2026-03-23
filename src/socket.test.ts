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
		try { fs.unlinkSync(socketPath); } catch {}
	}

	function wait(ms: number) {
		return new Promise(r => setTimeout(r, ms));
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
			expect(() => client.connect(socketPath)).toThrow("connect on already connected USocket");

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
			server.on("listening", () => { eventEmitted = true; });
			server.listen(socketPath);

			expect(eventEmitted).toBe(true);

			server.close();
		});

		it("should listen with callback", () => {
			const socketPath = path.join(testSocketDir, "server-cb");
			cleanup(socketPath);

			const server = new UServer();
			let callbackCalled = false;
			server.listen(socketPath, () => { callbackCalled = true; });

			expect(callbackCalled).toBe(true);
			expect(server.listening).toBe(true);

			server.close();
		});

		it("should listen with backlog and callback", () => {
			const socketPath = path.join(testSocketDir, "server-backlog-cb");
			cleanup(socketPath);

			const server = new UServer();
			let callbackCalled = false;
			server.listen(socketPath, 32, () => { callbackCalled = true; });

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

			expect(() => server.listen(socketPath2)).toThrow("listen on already listened UServer");

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

			const receivedData = await Promise.race([dataPromise, wait(1000).then(() => null)]);

			expect(receivedData).not.toBeNull();
			expect(receivedData!.toString()).toBe("Hello, Server!");

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
			client.write(Buffer.from("Hello from client"));
			const receivedByServer = await Promise.race([serverDataPromise, wait(1000).then(() => null)]);

			expect(receivedByServer).not.toBeNull();
			expect(receivedByServer!.toString()).toBe("Hello from client");

			// 服务器 -> 客户端
			const clientDataPromise = waitForData(client);
			serverSocket.write(Buffer.from("Hello from server"));
			const receivedByClient = await Promise.race([clientDataPromise, wait(1000).then(() => null)]);

			expect(receivedByClient).not.toBeNull();
			expect(receivedByClient!.toString()).toBe("Hello from server");

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
			server.on("close", () => { closeEmitted = true; });
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

			await Promise.race([finishPromise, wait(1000).then(() => { throw new Error("Timeout"); })]);

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

			const receivedData = await Promise.race([dataPromise, wait(1000).then(() => null)]);

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

			const serverReceived: string[] = [];
			const clientReceived: string[] = [];

			serverSocket.on("data", (data) => { serverReceived.push(data.toString()); });
			client.on("data", (data) => { clientReceived.push(data.toString()); });

			client.write(Buffer.from("Client: Hello 1"));
			await wait(50);
			serverSocket.write(Buffer.from("Server: Hi 1"));

			await wait(50);
			client.write(Buffer.from("Client: Hello 2"));
			await wait(50);
			serverSocket.write(Buffer.from("Server: Hi 2"));

			await wait(200);

			expect(serverReceived.length).toBeGreaterThanOrEqual(1);
			expect(serverReceived.join("")).toContain("Client: Hello");

			expect(clientReceived.length).toBeGreaterThanOrEqual(1);
			expect(clientReceived.join("")).toContain("Server: Hi");

			client.destroy();
			serverSocket.destroy();
			server.close();
		});
	});
});