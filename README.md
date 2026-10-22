# dashboard

The discovery service behind the infrastructure dashboard at `dashboard.solstice.krakowski.cloud`
(platform `apps/base/dashboard`). It lists the cluster's Traefik IngressRoutes and Ingresses, reads
the `dashboard.krakowski.cloud/*` annotations on them, and answers `GET /services.json` in the shape
the page already renders. Plan: fleet `docs/planning/2026-10-22_dashboard-auto-discovery-plan.md`.

- `GET /services.json`: `{ "<section>": [ { name, type, icon, description, href }, … ] }`, cached 30 s.
- `GET /healthz`: `200 ok`.
- Listens on 8080. Reads the in-cluster ServiceAccount token and CA; no other input.

Annotations on an IngressRoute or Ingress (all optional):

| Annotation | Meaning | Default |
|---|---|---|
| `dashboard.krakowski.cloud/section` | the section the card goes in | `Unsorted` |
| `dashboard.krakowski.cloud/name` | card title | the host |
| `dashboard.krakowski.cloud/type` | the small label on the card | `Service` |
| `dashboard.krakowski.cloud/icon` | Font Awesome class | `fa-cloud` |
| `dashboard.krakowski.cloud/description` | one line | empty |
| `dashboard.krakowski.cloud/href` | link | `https://<host>` |
| `dashboard.krakowski.cloud/hidden` | `"true"` hides the host, even when another object serves it | shown |

An object with several hosts yields one card per host: the annotations above apply to its first host only, and every other host gets a default card (name and link from the host) in the same section.

Run the tests with `yarn test`. The image is built by `.github/workflows/build-image.yml` on `main`
and promoted by digest with a platform pull request.
