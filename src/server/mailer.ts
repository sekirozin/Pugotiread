import net from "node:net";
import tls from "node:tls";
import { config } from "./config.js";

type MailMessage = {
  to: string;
  subject: string;
  text: string;
};

function escapeHeader(value: string): string {
  return value.replaceAll(/\r?\n/g, " ").trim();
}

function makeMessage({ to, subject, text }: MailMessage): string {
  return [
    `From: ${config.smtpFrom}`,
    `To: ${to}`,
    `Subject: ${escapeHeader(subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    text
  ].join("\r\n");
}

function waitForResponse(socket: net.Socket | tls.TLSSocket): Promise<{ code: number; lines: string[] }> {
  return new Promise((resolve, reject) => {
    let buffer = "";

    const cleanup = (): void => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };

    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    const onClose = (): void => {
      cleanup();
      reject(new Error("Conexão SMTP encerrada."));
    };

    const onData = (chunk: Buffer | string): void => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      if (lines.length === 0) {
        return;
      }

      const lastLine = lines[lines.length - 1] ?? "";
      if (!/^\d{3} /.test(lastLine)) {
        return;
      }

      cleanup();
      const code = Number(lastLine.slice(0, 3));
      resolve({ code, lines });
    };

    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

async function sendCommand(socket: net.Socket | tls.TLSSocket, command: string, expectCode: number): Promise<{ code: number; lines: string[] }> {
  socket.write(`${command}\r\n`);
  const response = await waitForResponse(socket);
  if (response.code !== expectCode) {
    throw new Error(`SMTP respondeu com ${response.code} ao enviar ${command.split(" ")[0]}.`);
  }
  return response;
}

async function upgradeToTls(socket: net.Socket): Promise<tls.TLSSocket> {
  socket.write("STARTTLS\r\n");
  const response = await waitForResponse(socket);
  if (response.code !== 220) {
    socket.destroy();
    throw new Error("Servidor SMTP recusou STARTTLS.");
  }

  return tls.connect({
    socket,
    servername: config.smtpHost
  });
}

async function sendSmtpMessage(message: MailMessage): Promise<void> {
  let socket: net.Socket | tls.TLSSocket = config.smtpSecure
    ? tls.connect(config.smtpPort, config.smtpHost, { servername: config.smtpHost })
    : net.connect(config.smtpPort, config.smtpHost);

  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });

  const greeting = await waitForResponse(socket);
  if (greeting.code !== 220) {
    socket.destroy();
    throw new Error("Servidor SMTP não respondeu corretamente.");
  }

  const hello = await sendCommand(socket, `EHLO ${config.smtpHost}`, 250);

  if (!config.smtpSecure && hello.lines.some((line) => line.toUpperCase().includes("STARTTLS"))) {
    socket = await upgradeToTls(socket as net.Socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("secureConnect", () => resolve());
      socket.once("error", reject);
    });
    await sendCommand(socket, `EHLO ${config.smtpHost}`, 250);
  }

  if (config.smtpUser) {
    await sendCommand(socket, "AUTH LOGIN", 334);
    socket.write(`${Buffer.from(config.smtpUser).toString("base64")}\r\n`);
    let response = await waitForResponse(socket);
    if (response.code !== 334) {
      socket.destroy();
      throw new Error("Falha na autenticação SMTP.");
    }

    socket.write(`${Buffer.from(config.smtpPass).toString("base64")}\r\n`);
    response = await waitForResponse(socket);
    if (response.code !== 235) {
      socket.destroy();
      throw new Error("Falha na autenticação SMTP.");
    }
  }

  await sendCommand(socket, `MAIL FROM:<${config.smtpFrom.match(/<([^>]+)>/)?.[1] ?? config.smtpFrom}>`, 250);
  await sendCommand(socket, `RCPT TO:<${message.to}>`, 250);
  socket.write("DATA\r\n");
  const dataResponse = await waitForResponse(socket);
  if (dataResponse.code !== 354) {
    socket.destroy();
    throw new Error("Servidor SMTP recusou a mensagem.");
  }

  const body = makeMessage(message).replaceAll(/^\./gm, "..");
  socket.write(`${body}\r\n.\r\n`);
  const sendResponse = await waitForResponse(socket);
  if (sendResponse.code !== 250) {
    socket.destroy();
    throw new Error("Servidor SMTP não aceitou a mensagem.");
  }

  socket.write("QUIT\r\n");
  socket.end();
}

export async function sendPasswordResetEmail(to: string, resetLink: string): Promise<void> {
  const subject = "Pugotiread - confirmação de troca de senha";
  const text = [
    "Recebemos um pedido para trocar sua senha no Pugotiread.",
    "",
    `Abra este link para confirmar a alteração: ${resetLink}`,
    "",
    "Se você não pediu isso, pode ignorar esta mensagem."
  ].join("\n");

  if (!config.smtpHost) {
    console.log(`[MAIL:FALLBACK] To: ${to}\nSubject: ${subject}\n${text}`);
    return;
  }

  await sendSmtpMessage({
    to,
    subject,
    text
  });
}
