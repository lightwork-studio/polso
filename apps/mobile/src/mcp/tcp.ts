import type TcpSocket from "react-native-tcp-socket";
import type { Connection, Listener, Listening } from "./listener";
import { encodeUtf8 } from "./utf8";

type Socket = InstanceType<typeof TcpSocket.Socket>;
type Server = InstanceType<typeof TcpSocket.Server>;

/** How long the phone may take to open the port before access reports a failure. */
export const LISTEN_TIMEOUT_MS = 10_000;

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
      try {
        socket.end(bytes);
      } catch {
        // The socket closed under us (the library throws on writes to a closed socket).
        socket.destroy();
      }
    },
    destroy: () => {
      socket.destroy();
    },
  };
}

/**
 * The library registers each server's listeners on a shared native event emitter and never removes
 * them, so every closed server, with its listener and token, would otherwise stay in memory.
 */
function release(server: Server): void {
  server._listeningListener?.remove();
  server._errorListener?.remove();
  server._connectionsListener?.remove();
}

/**
 * Listens on every network interface (Wi-Fi, cellular, and Tailscale when it runs) and hands each
 * connection to the listener. Rejects when the port can't be opened in time. The library loads
 * only here, so the app starts even if its native module is missing.
 */
export async function listenTcp(
  port: number,
  listener: Listener,
  onFailure: (error: Error) => void,
): Promise<Listening> {
  const { default: Tcp } = await import("react-native-tcp-socket");
  return new Promise((resolve, reject) => {
    const server = Tcp.createServer((socket) => listener.accept(connectionOf(socket)));
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      listener.stop();
      server.close();
      release(server);
    };
    const fail = (error: Error) => {
      clearTimeout(timer);
      close();
      reject(error);
    };
    const timer = setTimeout(
      () => fail(new Error("The port didn't open in time.")),
      LISTEN_TIMEOUT_MS,
    );
    server.once("error", fail);
    server.listen({ port, host: "0.0.0.0", reuseAddress: true }, () => {
      if (closed) return;
      clearTimeout(timer);
      server.off("error", fail);
      // A later failure closes the server and is reported, so the app shows access as stopped.
      server.on("error", (error) => {
        if (closed) return;
        close();
        onFailure(error);
      });
      resolve({ close });
    });
  });
}
