import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "@remix-run/react";

// 1. Import Polaris styles (Notice no "type" keyword before LinksFunction if using JS)
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";

// 2. Export the stylesheet link for Remix
export const links = () => [
  { rel: "stylesheet", href: polarisStyles },
];

export default function App() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}