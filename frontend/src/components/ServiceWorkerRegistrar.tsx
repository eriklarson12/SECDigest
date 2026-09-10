"use client";

import { useEffect } from "react";

/** Registers the service worker in public/sw.js. Renders nothing.
 *
 * Production only. In dev the worker would serve a precached shell over the
 * one the dev server just rebuilt, and every change would need a manual
 * unregister to show up. */
export default function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    // Registration failing is not worth surfacing: the app works without a
    // worker, and the browser has already logged the reason.
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, []);

  return null;
}
