import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { UServer, USocket } from "./index";

describe("Unix Socket Module", () => {
	const testSocketDir = "/tmp/usocket-tests";

	// 确保测试目录存在
	if (!fs.existsSync(testSocketDir)) {
		fs.mkdirSync(testSocketDir, { recursive: true });
	}

	// 清理函数
	function cleanupSocket(socketPath: string) {
		try {
			fs.unlinkSync(socketPath);
		} catch {}
	}

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

		it("should connect to a server", () => {
			const socketPath = path.join(testSocketDir, "client-connect");
			cleanupSocket(socketPath);

			const server = new UServer();
			server.listen(socketPath);

			const client = new USocket(socketPath);
			expect(client.fd).toBeDefined();

			client.close();
			server.close();
		});

		it("should throw error when connecting twice", () => {
			const socketPath = path.join(testSocketDir, "client-twice");
			cleanupSocket(socketPath);

			const server = new UServer();
			server.listen(socketPath);

			const client = new USocket(socketPath);
			expect(() => client.connect(socketPath)).toThrow(
				"connect on already connected USocket",
			);

			client.close();
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
			cleanupSocket(socketPath);

			const server = new UServer();
			server.listen(socketPath);

			expect(server.listening).toBe(true);
			expect(server.fd).toBeDefined();

			server.close();
		});

		it("should emit listening event", () => {
			const socketPath = path.join(testSocketDir, "server-event");
			cleanupSocket(socketPath);

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
			const socketPath1 = path.join(testSocketDir, "server-twice-1");
			const socketPath2 = path.join(testSocketDir, "server-twice-2");
			cleanupSocket(socketPath1);
			cleanupSocket(socketPath2);

			const server = new UServer();
			server.listen(socketPath1);

			expect(() => server.listen(socketPath2)).toThrow(
				"listen on already listened UServer",
			);

			server.close();
		});

		it("should return null when accepting without connections", () => {
			const socketPath = path.join(testSocketDir, "server-accept-null");
			cleanupSocket(socketPath);

			const server = new UServer();
			server.listen(socketPath);

			const socket = server.accept();
			expect(socket).toBeNull();

			server.close();
		});

		it("should handle pause and resume", () => {
			const socketPath = path.join(testSocketDir, "server-pause");
			cleanupSocket(socketPath);

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

		it("should accept a connection", () => {
			const socketPath = path.join(testSocketDir, "server-accept");
			cleanupSocket(socketPath);

			const server = new UServer();
			server.listen(socketPath);

			// 创建客户端连接
			const client = new USocket(socketPath);

			// 等待一下让连接建立
			const startTime = Date.now();
			let acceptedSocket: USocket | null = null;

			while (Date.now() - startTime < 1000) {
				acceptedSocket = server.accept();
				if (acceptedSocket) break;
			}

			expect(acceptedSocket).not.toBeNull();
			expect(acceptedSocket!.fd).toBeDefined();

			client.close();
			acceptedSocket!.close();
			server.close();
		});
	});

	describe("Data Transfer", () => {
		it("should write data from client to server", () => {
			const socketPath = path.join(testSocketDir, "transfer-write");
			cleanupSocket(socketPath);

			const server = new UServer();
			server.listen(socketPath);

			const client = new USocket(socketPath);

			// 等待服务器接受连接
			const startTime = Date.now();
			let serverSocket: USocket | null = null;

			while (Date.now() - startTime < 1000) {
				serverSocket = server.accept();
				if (serverSocket) break;
			}

			expect(serverSocket).not.toBeNull();

			// 客户端发送数据
			const testData = Buffer.from("Hello, Server!");
			const bytesWritten = client.write(testData);
			expect(bytesWritten).toBe(testData.length);

			client.close();
			serverSocket!.close();
			server.close();
		});

		it("should read data on server from client", () => {
			const socketPath = path.join(testSocketDir, "transfer-read");
			cleanupSocket(socketPath);

			const server = new UServer();
			server.listen(socketPath);

			const client = new USocket(socketPath);

			// 等待服务器接受连接
			const startTime = Date.now();
			let serverSocket: USocket | null = null;

			while (Date.now() - startTime < 1000) {
				serverSocket = server.accept();
				if (serverSocket) break;
			}

			expect(serverSocket).not.toBeNull();

			// 客户端发送数据
			const testData = Buffer.from("Hello, Server!");
			client.write(testData);

			// 等待数据到达并读取
			let receivedData: Buffer | null = null;
			const readStartTime = Date.now();

			while (Date.now() - readStartTime < 1000) {
				receivedData = serverSocket!.read(1024);
				if (receivedData && receivedData.length > 0) break;
			}

			expect(receivedData).not.toBeNull();
			expect(receivedData!.toString()).toBe("Hello, Server!");

			client.close();
			serverSocket!.close();
			server.close();
		});

		it("should transfer multiple messages", () => {
			const socketPath = path.join(testSocketDir, "transfer-multi");
			cleanupSocket(socketPath);

			const server = new UServer();
			server.listen(socketPath);

			const client = new USocket(socketPath);

			// 等待服务器接受连接
			const startTime = Date.now();
			let serverSocket: USocket | null = null;

			while (Date.now() - startTime < 1000) {
				serverSocket = server.accept();
				if (serverSocket) break;
			}

			expect(serverSocket).not.toBeNull();

			// 发送多条消息
			const messages = ["Message 1", "Message 2", "Message 3"];
			for (const msg of messages) {
				client.write(Buffer.from(msg));
			}

			// 读取所有消息
			const received: string[] = [];
			const readStartTime = Date.now();

			while (Date.now() - readStartTime < 1000) {
				const data = serverSocket!.read(1024);
				if (data && data.length > 0) {
					received.push(data.toString());
				}
				if (received.join("").length >= messages.join("").length) break;
			}

			expect(received.join("")).toBe(messages.join(""));

			client.close();
			serverSocket!.close();
			server.close();
		});

		it("should transfer large data", () => {
			const socketPath = path.join(testSocketDir, "transfer-large");
			cleanupSocket(socketPath);

			const server = new UServer();
			server.listen(socketPath);

			const client = new USocket(socketPath);

			// 等待服务器接受连接
			const startTime = Date.now();
			let serverSocket: USocket | null = null;

			while (Date.now() - startTime < 1000) {
				serverSocket = server.accept();
				if (serverSocket) break;
			}

			expect(serverSocket).not.toBeNull();

			// 发送大数据（10KB）
			const largeData = Buffer.alloc(10240, "A");
			const bytesWritten = client.write(largeData);
			expect(bytesWritten).toBe(largeData.length);

			// 读取大数据
			let receivedData = Buffer.alloc(0);
			const readStartTime = Date.now();

			while (Date.now() - readStartTime < 1000) {
				const chunk = serverSocket!.read(4096);
				if (chunk && chunk.length > 0) {
					receivedData = Buffer.concat([receivedData, chunk]);
				}
				if (receivedData.length >= largeData.length) break;
			}

			expect(receivedData.length).toBe(largeData.length);
			expect(receivedData.equals(largeData)).toBe(true);

			client.close();
			serverSocket!.close();
			server.close();
		});

		it("should handle bidirectional communication", () => {
			const socketPath = path.join(testSocketDir, "transfer-bidirectional");
			cleanupSocket(socketPath);

			const server = new UServer();
			server.listen(socketPath);

			const client = new USocket(socketPath);

			// 等待服务器接受连接
			const startTime = Date.now();
			let serverSocket: USocket | null = null;

			while (Date.now() - startTime < 1000) {
				serverSocket = server.accept();
				if (serverSocket) break;
			}

			expect(serverSocket).not.toBeNull();

			// 客户端发送数据到服务器
			const clientData = Buffer.from("Hello from client");
			client.write(clientData);

			// 服务器读取
			let receivedByServer: Buffer | null = null;
			const readStartTime1 = Date.now();

			while (Date.now() - readStartTime1 < 1000) {
				receivedByServer = serverSocket!.read(1024);
				if (receivedByServer && receivedByServer.length > 0) break;
			}

			expect(receivedByServer!.toString()).toBe("Hello from client");

			// 服务器发送响应到客户端
			const serverData = Buffer.from("Hello from server");
			serverSocket!.write(serverData);

			// 客户端读取
			let receivedByClient: Buffer | null = null;
			const readStartTime2 = Date.now();

			while (Date.now() - readStartTime2 < 1000) {
				receivedByClient = client.read(1024);
				if (receivedByClient && receivedByClient.length > 0) break;
			}

			expect(receivedByClient!.toString()).toBe("Hello from server");

			client.close();
			serverSocket!.close();
			server.close();
		});
	});

	describe("File Descriptor Transfer (SCM_RIGHTS)", () => {
		it("should send and receive file descriptor", () => {
			const socketPath = path.join(testSocketDir, "fd-transfer");
			cleanupSocket(socketPath);

			// 创建临时文件
			const tmpFile = path.join(os.tmpdir(), `usocket-test-${Date.now()}.txt`);
			const testContent = "Hello from transferred fd!";
			fs.writeFileSync(tmpFile, testContent);

			// 获取文件描述符
			const fileFd = fs.openSync(tmpFile, "r");

			const server = new UServer();
			server.listen(socketPath);

			const client = new USocket(socketPath);

			// 等待服务器接受连接
			const startTime = Date.now();
			let serverSocket: USocket | null = null;

			while (Date.now() - startTime < 1000) {
				serverSocket = server.accept();
				if (serverSocket) break;
			}

			expect(serverSocket).not.toBeNull();

			// 客户端发送 fd
			const message = Buffer.from("fd-transfer");
			const bytesWritten = client.write(message, [fileFd]);
			expect(bytesWritten).toBe(message.length);

			// 服务器读取 fd
			let result: { data: Buffer | null; fds: number[] } | null = null;
			const readStartTime = Date.now();

			while (Date.now() - readStartTime < 1000) {
				result = serverSocket!.readWithFds(1024);
				if (result && result.fds.length > 0) break;
			}

			expect(result).not.toBeNull();
			expect(result!.fds.length).toBe(1);

			// 使用接收到的 fd 读取文件内容
			const receivedFd = result!.fds[0];
			const readContent = fs.readFileSync(receivedFd, "utf-8");
			expect(readContent).toBe(testContent);

			// 清理
			fs.closeSync(fileFd);
			fs.closeSync(receivedFd);
			fs.unlinkSync(tmpFile);

			client.close();
			serverSocket!.close();
			server.close();
		});

		it("should send and receive multiple file descriptors", () => {
			const socketPath = path.join(testSocketDir, "fd-transfer-multi");
			cleanupSocket(socketPath);

			// 创建多个临时文件
			const tmpFiles: string[] = [];
			const fileFds: number[] = [];
			const testContents: string[] = [];

			for (let i = 0; i < 3; i++) {
				const tmpFile = path.join(
					os.tmpdir(),
					`usocket-test-${Date.now()}-${i}.txt`,
				);
				const testContent = `File content ${i}`;
				fs.writeFileSync(tmpFile, testContent);
				tmpFiles.push(tmpFile);
				fileFds.push(fs.openSync(tmpFile, "r"));
				testContents.push(testContent);
			}

			const server = new UServer();
			server.listen(socketPath);

			const client = new USocket(socketPath);

			// 等待服务器接受连接
			const startTime = Date.now();
			let serverSocket: USocket | null = null;

			while (Date.now() - startTime < 1000) {
				serverSocket = server.accept();
				if (serverSocket) break;
			}

			expect(serverSocket).not.toBeNull();

			// 客户端发送多个 fd
			const message = Buffer.from("multi-fd-transfer");
			const bytesWritten = client.write(message, fileFds);
			expect(bytesWritten).toBe(message.length);

			// 服务器读取 fd
			let result: { data: Buffer | null; fds: number[] } | null = null;
			const readStartTime = Date.now();

			while (Date.now() - readStartTime < 1000) {
				result = serverSocket!.readWithFds(1024);
				if (result && result.fds.length >= 3) break;
			}

			expect(result).not.toBeNull();
			expect(result!.fds.length).toBe(3);

			// 验证每个 fd 的内容
			for (let i = 0; i < 3; i++) {
				const readContent = fs.readFileSync(result!.fds[i], "utf-8");
				expect(readContent).toBe(testContents[i]);
			}

			// 清理
			for (const fd of fileFds) {
				fs.closeSync(fd);
			}
			for (const fd of result!.fds) {
				fs.closeSync(fd);
			}
			for (const tmpFile of tmpFiles) {
				fs.unlinkSync(tmpFile);
			}

			client.close();
			serverSocket!.close();
			server.close();
		});

		// 跨进程 fd 传输测试需要更复杂的同步机制，暂时跳过
		// 可以使用 child_process.fork 或 spawn 来实现
	});
});
