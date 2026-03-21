import { describe, it, expect } from 'vitest';
import { USocket, UServer } from './index';

describe('Unix Socket Module', () => {
  describe('USocket', () => {
    it('should create a new instance', () => {
      const socket = new USocket();
      expect(socket).toBeDefined();
    });

    it('should throw error when writing to unconnected socket', () => {
      const socket = new USocket();
      expect(() => socket.write(Buffer.from('test'))).toThrow('USocket not connected');
    });
  });

  describe('UServer', () => {
    it('should create a new instance', () => {
      const server = new UServer();
      expect(server).toBeDefined();
      expect(server.listening).toBe(false);
    });
  });
});