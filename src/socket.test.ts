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

		it("should emit connect event", () => {
			const socketPath = path.join(testSocketDir, "client-connect-event");
			cleanupSocket(socketPath);

			const server = new UServer();
			server.listen(socketPath);

			let connectEmitted = false;
			const client = new USocket();
			client.on("connect", () => {
				connectEmitted = true;
			});
			client.connect(socketPath);

			expect(connectEmitted).toBe(true);

			client.close();
			server.close();
		});

		it("should call connect callback", () => {
			const socketPath = path.join(testSocketDir, "client-connect-cb");
			cleanupSocket(socketPath);

			const server = new UServer();
			server.listen(socketPath);

			let callbackCalled = false;
			const client = new USocket();
			client.connect(socketPath, () => {
				callbackCalled = true;
			});

			expect(callbackCalled).toBe(true);

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

		it("should listen with callback (path, cb)", () => {
			const socketPath = path.join(testSocketDir, "server-cb");
			cleanupSocket(socketPath);

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
			cleanupSocket(socketPath);

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

		it("should emit connection event when accept is called", async () => {
			const socketPath = path.join(testSocketDir, "server-connection-event");
			cleanupSocket(socketPath);

			const server = new UServer();
			server.listen(socketPath);

			let connectionEmitted = false;
			let receivedSocket: USocket | null = null;

			server.on("connection", (socket: USocket) => {
				connectionEmitted = true;
				receivedSocket = socket;
			});

			// 启动自动接受连接
			server.resume();

			const client = new USocket(socketPath);

			// 等待 connection 事件
			await new Promise<void>((resolve) => {
				const check = () => {
					if (connectionEmitted) {
						resolve();
					} else {
						setTimeout(check, 10);
					}
				};
				check();
			});

			expect(connectionEmitted).toBe(true);
			expect(receivedSocket).not.toBeNull();

			client.close();
			receivedSocket!.close();
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

		it("should accept a connection", async () => {
			const socketPath = path.join(testSocketDir, "server-accept");
			cleanupSocket(socketPath);

			const server = new UServer();
			server.listen(socketPath);

			// 等待连接
			const connectionPromise = new Promise<USocket>((resolve) => {
				server.on("connection", (socket: USocket) => {
					resolve(socket);
				});
			});

			// 启动自动接受连接
			server.resume();

			// 创建客户端连接
			const client = new USocket(socketPath);

			// 等待连接
			const acceptedSocket = await Promise.race([
				connectionPromise,
				new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
			]);

			expect(acceptedSocket).not.toBeNull();
			expect(acceptedSocket!.fd).toBeDefined();

			client.close();
			acceptedSocket!.close();
			server.close();
		});
	});

	describe("Data Transfer", () => {
		it("should write data from client to server", async () => {
			const socketPath = path.join(testSocketDir, "transfer-write");
			cleanupSocket(socketPath);

			const server = new UServer();
			server.listen(socketPath);

			// 等待连接
			const connectionPromise = new Promise<USocket>((resolve) => {
				server.on("connection", (socket: USocket) => {
					resolve(socket);
				});
			});

			server.resume();

			const client = new USocket(socketPath);

			// 等待连接
			const serverSocket = await connectionPromise;

			expect(serverSocket).not.toBeNull();

			// 客户端发送数据
			const testData = Buffer.from("Hello, Server!");
			const bytesWritten = client.write(testData);
			expect(bytesWritten).toBe(true);

			client.close();
			serverSocket.close();
			server.close();
		});

		it("should read data on server from client using readable event", async () => {
			const socketPath = path.join(testSocketDir, "transfer-read");
			cleanupSocket(socketPath);

			const server = new UServer();
			server.listen(socketPath);

			// 等待连接
			const connectionPromise = new Promise<USocket>((resolve) => {
				server.on("connection", (socket: USocket) => {
					resolve(socket);
				});
			});

			server.resume();

			const client = new USocket(socketPath);

			// 等待连接
			const serverSocket = await connectionPromise;

			expect(serverSocket).not.toBeNull();

			// 使用 readable 事件读取数据
			const dataPromise = new Promise<Buffer>((resolve) => {
				serverSocket.on("readable", () => {
					const data = serverSocket.read();
					if (data && Buffer.isBuffer(data) && data.length > 0) {
						resolve(data);
					}
				});
			});

			// 客户端发送数据
			const testData = Buffer.from("Hello, Server!");
			client.write(testData);

			// 等待 readable 事件
			const receivedData = await Promise.race([
				dataPromise,
				new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
			]);

			expect(receivedData).not.toBeNull();
			expect(receivedData!.toString()).toBe("Hello, Server!");

			client.close();
			serverSocket.close();
			server.close();
		});

		it("should transfer multiple messages using readable event", async () => {
			const socketPath = path.join(testSocketDir, "transfer-multi");
			cleanupSocket(socketPath);

			const server = new UServer();
			server.listen(socketPath);

			// 等待连接
			const connectionPromise = new Promise<USocket>((resolve) => {
				server.on("connection", (socket: USocket) => {
					resolve(socket);
				});
			});

			server.resume();

			const client = new USocket(socketPath);

			// 等待连接
			const serverSocket = await connectionPromise;

			expect(serverSocket).not.toBeNull();

			// 收集所有接收的数据
			const received: string[] = [];
			const messages = ["Message 1", "Message 2", "Message 3"];

			const dataPromise = new Promise<string[]>((resolve) => {
				serverSocket.on("readable", () => {
					const data = serverSocket.read();
					if (data && Buffer.isBuffer(data) && data.length > 0) {
						received.push(data.toString());
						if (received.join("").length >= messages.join("").length) {
							resolve(received);
						}
					}
				});
			});

			// 发送多条消息
			for (const msg of messages) {
				client.write(Buffer.from(msg));
			}

			// 等待所有数据
			await Promise.race([
				dataPromise,
				new Promise<void>((resolve) => setTimeout(resolve, 1000)),
			]);

			expect(received.join("")).toBe(messages.join(""));

			client.close();
			serverSocket.close();
			server.close();
		});

		it("should handle bidirectional communication using readable event", async () => {
			const socketPath = path.join(testSocketDir, "transfer-bidirectional");
			cleanupSocket(socketPath);

			const server = new UServer();
			server.listen(socketPath);

			// 等待连接
			const connectionPromise = new Promise<USocket>((resolve) => {
				server.on("connection", (socket: USocket) => {
					resolve(socket);
				});
			});

			server.resume();

			const client = new USocket(socketPath);

			// 等待连接
			const serverSocket = await connectionPromise;

			expect(serverSocket).not.toBeNull();

			// 服务器使用 readable 事件读取数据
			const serverDataPromise = new Promise<Buffer>((resolve) => {
				serverSocket.on("readable", () => {
					const data = serverSocket.read();
					if (data && Buffer.isBuffer(data) && data.length > 0) {
						resolve(data);
					}
				});
			});

			// 客户端发送数据到服务器
			const clientData = Buffer.from("Hello from client");
			client.write(clientData);

			// 等待服务器收到数据
			const receivedByServer = await Promise.race([
				serverDataPromise,
				new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
			]);

			expect(receivedByServer).not.toBeNull();
			expect(receivedByServer!.toString()).toBe("Hello from client");

			// 客户端使用 readable 事件读取数据
			const clientDataPromise = new Promise<Buffer>((resolve) => {
				client.on("readable", () => {
					const data = client.read();
					if (data && Buffer.isBuffer(data) && data.length > 0) {
						resolve(data);
					}
				});
			});

			// 服务器发送响应到客户端
			const serverData = Buffer.from("Hello from server");
			serverSocket.write(serverData);

			// 等待客户端收到数据
			const receivedByClient = await Promise.race([
				clientDataPromise,
				new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
			]);

			expect(receivedByClient).not.toBeNull();
			expect(receivedByClient!.toString()).toBe("Hello from server");

			client.close();
			serverSocket.close();
			server.close();
		});
	});

	describe("File Descriptor Transfer (SCM_RIGHTS)", () => {
		it("should send and receive file descriptor using readable event", async () => {
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

			// 等待连接
			const connectionPromise = new Promise<USocket>((resolve) => {
				server.on("connection", (socket: USocket) => {
					resolve(socket);
				});
			});

			server.resume();

			const client = new USocket(socketPath);

			// 等待连接
			const serverSocket = await connectionPromise;

			expect(serverSocket).not.toBeNull();

			// 使用 readable 事件读取 fd
			const fdPromise = new Promise<{ data: Buffer | null; fds: number[] }>(
				(resolve) => {
					serverSocket.on("readable", () => {
						const r = serverSocket.read(1024, 1);
						if (
							r &&
							typeof r === "object" &&
							"fds" in r &&
							Array.isArray(r.fds) &&
							r.fds.length > 0
						) {
							resolve(r as { data: Buffer | null; fds: number[] });
						}
					});
				},
			);

			// 客户端发送 fd
			const message = Buffer.from("fd-transfer");
			const written = client.write({ data: message, fds: [fileFd] });
			expect(written).toBe(true);

			// 等待 readable 事件
			const result = await Promise.race([
				fdPromise,
				new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
			]);

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
			serverSocket.close();
			server.close();
		});

		it("should send and receive multiple file descriptors using readable event", async () => {
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

			// 等待连接
			const connectionPromise = new Promise<USocket>((resolve) => {
				server.on("connection", (socket: USocket) => {
					resolve(socket);
				});
			});

			server.resume();

			const client = new USocket(socketPath);

			// 等待连接
			const serverSocket = await connectionPromise;

			expect(serverSocket).not.toBeNull();

			// 使用 readable 事件读取多个 fd
			const fdsPromise = new Promise<{ data: Buffer | null; fds: number[] }>(
				(resolve) => {
					serverSocket.on("readable", () => {
						const r = serverSocket.read(1024, 3);
						if (
							r &&
							typeof r === "object" &&
							"fds" in r &&
							Array.isArray(r.fds) &&
							r.fds.length >= 3
						) {
							resolve(r as { data: Buffer | null; fds: number[] });
						}
					});
				},
			);

			// 客户端发送多个 fd
			const message = Buffer.from("multi-fd-transfer");
			const written = client.write({ data: message, fds: fileFds });
			expect(written).toBe(true);

			// 等待 readable 事件
			const result = await Promise.race([
				fdsPromise,
				new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
			]);

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
			serverSocket.close();
			server.close();
		});
	});

	describe("Events", () => {
		it("should emit close event", () => {
			const socketPath = path.join(testSocketDir, "event-close");
			cleanupSocket(socketPath);

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
			cleanupSocket(socketPath);

			const server = new UServer();
			server.listen(socketPath);

			// 等待连接
			const connectionPromise = new Promise<USocket>((resolve) => {
				server.on("connection", (socket: USocket) => {
					resolve(socket);
				});
			});

			server.resume();

			const client = new USocket(socketPath);

			// 等待连接
			const serverSocket = await connectionPromise;

			expect(serverSocket).not.toBeNull();

			let finishEmitted = false;
			client.on("finish", () => {
				finishEmitted = true;
			});

			client.end();

			expect(finishEmitted).toBe(true);

			client.close();
			serverSocket.close();
			server.close();
		});

		it("should emit readable event when data arrives", async () => {
			const socketPath = path.join(testSocketDir, "event-readable");
			cleanupSocket(socketPath);

			const server = new UServer();
			server.listen(socketPath);

			// 等待连接
			const connectionPromise = new Promise<USocket>((resolve) => {
				server.on("connection", (socket: USocket) => {
					resolve(socket);
				});
			});

			server.resume();

			const client = new USocket(socketPath);

			// 等待连接
			const serverSocket = await connectionPromise;

			expect(serverSocket).not.toBeNull();

			// 使用 readable 事件读取数据
			const readablePromise = new Promise<Buffer>((resolve) => {
				serverSocket.on("readable", () => {
					const data = serverSocket.read();
					if (data && Buffer.isBuffer(data) && data.length > 0) {
						resolve(data);
					}
				});
			});

			// 发送数据
			const testData = Buffer.from("Hello readable!");
			client.write(testData);

			// 等待 readable 事件
			const receivedData = await Promise.race([
				readablePromise,
				new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
			]);

			expect(receivedData).not.toBeNull();
			expect(receivedData!.toString()).toBe("Hello readable!");

			client.close();
			serverSocket.close();
			server.close();
		});

		it("should emit end event on shutdown", async () => {
			const socketPath = path.join(testSocketDir, "event-end");
			cleanupSocket(socketPath);

			const server = new UServer();
			server.listen(socketPath);

			// 等待连接
			const connectionPromise = new Promise<USocket>((resolve) => {
				server.on("connection", (socket: USocket) => {
					resolve(socket);
				});
			});

			server.resume();

			const client = new USocket(socketPath);

			// 等待连接
			const serverSocket = await connectionPromise;

			expect(serverSocket).not.toBeNull();

			const endPromise = new Promise<void>((resolve) => {
				client.on("end", () => {
					resolve();
				});
			});

			client.shutdown();

			// 等待 end 事件
			await Promise.race([
				endPromise,
				new Promise<void>((resolve) => setTimeout(resolve, 1000)),
			]);

			client.close();
			serverSocket.close();
			server.close();
		});

		it("should handle multiple rounds of conversation with readable events", async () => {
			const socketPath = path.join(testSocketDir, "event-multi-round");
			cleanupSocket(socketPath);

			const server = new UServer();
			server.listen(socketPath);

			// 等待连接
			const connectionPromise = new Promise<USocket>((resolve) => {
				server.on("connection", (socket: USocket) => {
					resolve(socket);
				});
			});

			server.resume();

			const client = new USocket(socketPath);

			// 等待连接
			const serverSocket = await connectionPromise;

			expect(serverSocket).not.toBeNull();

			// 收集服务器收到的消息
			const serverReceived: string[] = [];
			const clientReceived: string[] = [];

			// 服务器监听 readable 事件
			serverSocket.on("readable", () => {
				const data = serverSocket.read();
				if (data && Buffer.isBuffer(data) && data.length > 0) {
					serverReceived.push(data.toString());
				}
			});

			// 客户端监听 readable 事件
			client.on("readable", () => {
				const data = client.read();
				if (data && Buffer.isBuffer(data) && data.length > 0) {
					clientReceived.push(data.toString());
				}
			});

			// 第一轮对话
			client.write(Buffer.from("Client: Hello 1"));
			await new Promise((r) => setTimeout(r, 50));
			serverSocket.write(Buffer.from("Server: Hi 1"));

			// 第二轮对话
			await new Promise((r) => setTimeout(r, 50));
			client.write(Buffer.from("Client: Hello 2"));
			await new Promise((r) => setTimeout(r, 50));
			serverSocket.write(Buffer.from("Server: Hi 2"));

			// 第三轮对话
			await new Promise((r) => setTimeout(r, 50));
			client.write(Buffer.from("Client: Hello 3"));
			await new Promise((r) => setTimeout(r, 50));
			serverSocket.write(Buffer.from("Server: Hi 3"));

			// 等待所有消息到达
			await new Promise((r) => setTimeout(r, 200));

			// 验证服务器收到的消息
			expect(serverReceived.length).toBeGreaterThanOrEqual(1);
			expect(serverReceived.join("")).toContain("Client: Hello");

			// 验证客户端收到的消息
			expect(clientReceived.length).toBeGreaterThanOrEqual(1);
			expect(clientReceived.join("")).toContain("Server: Hi");

			client.close();
			serverSocket.close();
			server.close();
		});
	});
});
