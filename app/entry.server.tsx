import type { EntryContext } from "@remix-run/node";
import { createReadableStreamFromReadable } from "@remix-run/node";
import { RemixServer } from "@remix-run/react";
import { isbot } from "isbot";
import { renderToPipeableStream } from "react-dom/server";
import { PassThrough } from "node:stream";
import { addDocumentResponseHeaders } from "./shopify.server";

export const streamTimeout = 5000;

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  remixContext: EntryContext
) {
  // Appends required Shopify frame-ancestors & CSP security headers
  addDocumentResponseHeaders(request, responseHeaders);

  const userAgent = request.headers.get("user-agent");
  const callbackName = isbot(userAgent ?? "") ? "onAllReady" : "onShellReady";

  return new Promise((resolve, reject) => {
    let shellRendered = false;
    let statusCode = responseStatusCode;

    const { pipe, abort } = renderToPipeableStream(
      <RemixServer context={remixContext} url={request.url} />,
      {
        [callbackName]() {
          shellRendered = true;
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");

          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: statusCode,
            })
          );

          pipe(body);
        },
        onShellError(error: unknown) {
          reject(error);
        },
        onError(error: unknown) {
          statusCode = 500;
          if (shellRendered) {
            console.error("[SSR Render Error]", error);
          }
        },
      }
    );

    // Automatically abort rendering if it exceeds the stream timeout
    setTimeout(abort, streamTimeout + 1000);
  });
}