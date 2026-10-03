import type { HeadersFunction, LinksFunction, MetaFunction } from "@remix-run/node";
import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "@remix-run/react";
import type { ReactNode } from "react";
import styles from "./styles.css?url";

export const links: LinksFunction = () => [{ rel: "stylesheet", href: styles }];

export const meta: MetaFunction = () => [
  { title: "editr build status" },
  { name: "robots", content: "noindex, nofollow" },
];

// Read-only internal page: never indexed, never framed, no referrer leaks.
export const headers: HeadersFunction = () => ({
  "X-Robots-Tag": "noindex, nofollow",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
});

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#111214" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary() {
  return (
    <div className="wrap">
      <h1>editr — build status</h1>
      <p className="err">The status could not be loaded. It reloads by itself; try again in a moment.</p>
    </div>
  );
}
