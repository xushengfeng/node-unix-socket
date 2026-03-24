import * as fs from "node:fs";
import * as path from "node:path";
import * as child_process from "node:child_process";
import { describe, expect, it } from "vitest";
import { UServer, USocket } from "../src/index";

describe("Rust CLI Echo Tests", () => {
	const testSocketDir = "/tmp/rust-cli-tests";
	const rustBinDir = path.join(__dirname, "..", "target", "debug");

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

	function startRustEchoServer(socketPath: string): child_process.ChildProcess {
		const serverBin = path.join(rustBinDir, "echo-server");
		const proc = child_process.spawn(serverBin, [socketPath], {
			stdio: ["pipe", "pipe", "pipe"],
		});

		// Wait for server to start
		return proc;
	}

	function runRustEchoClient(
		socketPath: string,
		message: string,
	): Promise<string> {
		const clientBin = path.join(rustBinDir, "echo-client");
		return new Promise((resolve, reject) => {
			const proc = child_process.spawn(clientBin, [socketPath, message], {
				stdio: ["pipe", "pipe", "pipe"],
			});

			let stdout = "";
			let stderr = "";

			proc.stdout.on("data", (data) => {
				stdout += data.toString();
			});

			proc.stderr.on("data", (data) => {
				stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (code !== 0) {
					reject(new Error(`Client exited with code ${code}: ${stderr}`));
				} else {
					resolve(stdout.trim());
				}
			});

			proc.on("error", reject);
		});
	}

	describe("Rust Echo Server + JS Client", () => {
		it("should echo message from JS client", async () => {
			const socketPath = path.join(testSocketDir, "rust-server-js-client.sock");
			cleanup(socketPath);

			const serverProc = startRustEchoServer(socketPath);
			await wait(200); // Wait for server to start

			try {
				const client = new USocket(socketPath);
				expect(client.fd).toBeDefined();

				const testMessage = "Hello from JS client!";
				const dataPromise = waitForData(client);
				client.write(Buffer.from(testMessage));

				const receivedData = await Promise.race([
					dataPromise,
					wait(1000).then(() => null),
				]);

				expect(receivedData).not.toBeNull();
				expect(receivedData!.toString()).toBe(testMessage);

				client.destroy();
			} finally {
				serverProc.kill();
				cleanup(socketPath);
			}
		});

		it("should echo multiple messages", async () => {
			const socketPath = path.join(testSocketDir, "rust-server-multi.sock");
			cleanup(socketPath);

			const serverProc = startRustEchoServer(socketPath);
			await wait(200);

			try {
				const client = new USocket(socketPath);
				const messages = ["msg1", "msg2", "msg3"];
				const received: string[] = [];

				client.on("data", (data: Buffer) => {
					received.push(data.toString());
				});

				for (const msg of messages) {
					client.write(Buffer.from(msg));
					await wait(50);
				}

				await wait(200);

				expect(received.length).toBeGreaterThanOrEqual(messages.length);
				for (let i = 0; i < messages.length; i++) {
					expect(received[i]).toBe(messages[i]);
				}

				client.destroy();
			} finally {
				serverProc.kill();
				cleanup(socketPath);
			}
		});
	});

	describe("JS Server + Rust Echo Client", () => {
		it("should receive message from Rust client", async () => {
			const socketPath = path.join(testSocketDir, "js-server-rust-client.sock");
			cleanup(socketPath);

			const server = new UServer();
			server.listen(socketPath);
			server.resume(); // Ensure server is ready to accept connections

			try {
				const serverSocketPromise = waitForConnection(server);
				await wait(100); // Give server time to start listening
				const testMessage = "Hello from Rust client!";

				const clientPromise = runRustEchoClient(socketPath, testMessage);
				const serverSocket = await serverSocketPromise;

				const dataPromise = waitForData(serverSocket);
				const receivedByServer = await Promise.race([
					dataPromise,
					wait(1000).then(() => null),
				]);

				expect(receivedByServer).not.toBeNull();
				expect(receivedByServer!.toString()).toBe(testMessage);

				// Server echoes back
				serverSocket.write(receivedByServer!);

				const clientResponse = await clientPromise;
				expect(clientResponse).toBe(testMessage);

				serverSocket.destroy();
			} finally {
				server.close();
				cleanup(socketPath);
			}
		});

		it("should handle large message from Rust client", async () => {
			const socketPath = path.join(testSocketDir, "js-server-large.sock");
			cleanup(socketPath);

			const server = new UServer();
			server.listen(socketPath);
			server.resume(); // Ensure server is ready to accept connections

			try {
				const serverSocketPromise = waitForConnection(server);
				await wait(100); // Give server time to start listening
				const largeMessage = "X".repeat(4096);

				const clientPromise = runRustEchoClient(socketPath, largeMessage);
				const serverSocket = await serverSocketPromise;

				let received = Buffer.alloc(0);
				serverSocket.on("data", (data: Buffer) => {
					received = Buffer.concat([received, data]);
				});

				// Wait for all data
				while (received.length < largeMessage.length) {
					await wait(10);
				}

				expect(received.toString()).toBe(largeMessage);

				// Server echoes back
				serverSocket.write(received);

				const clientResponse = await clientPromise;
				expect(clientResponse).toBe(largeMessage);

				serverSocket.destroy();
			} finally {
				server.close();
				cleanup(socketPath);
			}
		});
	});
});
