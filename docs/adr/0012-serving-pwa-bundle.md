# 0012. Hono serves the PWA

- **Status:** Proposed
- **Date:** 2026-10-29
- **Deciders:** Marek Culak
- **Ticket:** YGP-n

## Context

The goal is one container that runs the client and the control plane as one web app. The PoC uses two containers: nginx serves the PWA and proxies `/api` to the backend. The target deployment is our k8s cluster; the PoC runs on Docker Compose. CDN considerations are left to the infra tickets.

## Options considered

1. **Hono serves the built static PWA and the API from one container**.
    - Pros: one image and deploy; same origin (no CORS, simpler cookies); matches the one-container goal.
    - Cons: static traffic shares pods with the API at conference start; Hono's static serving is basic.
2. **Separate nginx container for the PWA, as in the PoC**.
    - Pros: nginx is strong at static files and scales separately; the PoC already works this way.
    - Cons: two deployables and proxy configuration; against the one-container goal.
3. **CDN, ingress caching, or edge reverse proxy for static files**.
    - Pros: takes static traffic off the pods entirely; best for large bursts.
    - Cons: extra infrastructure and cost; deferred to the infra tickets.

## Decision

We will let Hono serve the built PWA **as the initial implementation**, keeping the client and API on one origin and single deployable unit.

**Timeline and Migration Note:**  
Serving static assets through Hono is built-in and selected for initial simplicity and operational alignment, **not as an immutable end-state or rejected concept**. Moving static file delivery out of Hono—either by offloading caching to an Nginx reverse proxy / K8s Ingress layer or deploying behind a CDN/object storage bucket—is **a timeline question rather than a architectural rejection**. Hono will handle serving out-of-the-box today, and offloading to an edge proxy or CDN will be introduced in later phases as traffic growth or measured load during conference start bursts dictates.

**Why the other options are not used immediately:**

- **Separate nginx container**: it is the better static server, but the goal is one container for the web app, and a second container buys little until static traffic is a measured bottleneck.
- **CDN or object storage**: the right tool for a load burst, but it belongs to subsequent infrastructure milestones and adds external infrastructure dependencies before there is a measured need.

## Consequences

- Good: a single image to build and run; no CORS configuration; clear upgrade path to proxy-level caching without application code changes.
- Bad / trade-offs: until CDN or reverse proxy caching is enabled, a burst of listeners loading the app shell competes with join requests on the same pods; the service worker softens this for repeat visits (ADR 0010).
- Follow-up work: cache headers (long-lived for hashed assets, none for the entry page and service worker); multi-stage Dockerfile; defining load triggers for enabling ingress proxy caching or CDN offloading in infra tickets.