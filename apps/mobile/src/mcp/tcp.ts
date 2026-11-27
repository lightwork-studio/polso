import TcpSocket from "react-native-tcp-socket";
import type { Connection, Listener, Listening } from "./listener";
import { encodeUtf8 } from "./utf8";

type Socket = InstanceType<typeof TcpSocket.Socket>;

function connectionOf(socket: Socket): Connection {
  return {
    onData: (listener) =>
      socket.on("data", (data) => listener(typeof data === "string" ? encodeUtf8(data) : data)),
    onClose: (listener) => {
      let closed = false;
      const once = () => {
        if (closed) return;
        closed = true;
        listener();
      };
      socket.on("close", once);
      socket.on("error", once);
    },
    endWith: (bytes) => {
      socket.end(bytes);
    },
    destroy: () => {
      socket.destroy();
    },
  };
}

/**
 * Listens on every network interface (Wi-Fi, and Tailscale when it runs) and hands each
 * connection to the listener. Rejects when the port can't be opened.
 */
export function listenTcp(
  port: number,
  listener: Listener,
  onFailure: (error: Error) => void,
): Promise<Listening> {
  return new Promise((resolve, reject) => {
    const server = TcpSocket.createServer((socket) => listener.accept(connectionOf(socket)));
    const fail = (error: Error) => {
      listener.stop();
      server.close();
      reject(error);
    };
    server.once("error", fail);
    server.listen({ port, host: "0.0.0.0", reuseAddress: true }, () => {
      server.off("error", fail);
      // A later failure closes the server and is reported, so the app shows access as stopped.
      server.on("error", (error) => {
        listener.stop();
        server.close();
        onFailure(error);
      });
      resolve({
        close: () => {
          listener.stop();
          server.close();
        },
      });
    });
  });
}
