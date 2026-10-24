// Point d'entrée : les pages (dossier public/) sont servies directement par Cloudflare, sans passer par ce code,
// sauf la page d'accueil « / ». Les adresses restent celles de la version PC (/board.html, sans redirection).
// /ws (temps réel) et /api/* arrivent ici, et tout est confié au Durable Object « Table ».
import { Table } from './table.js';

export { Table };

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/') return env.ASSETS.fetch(new Request(new URL('/index.html', request.url), request));
    const table = env.TABLE.get(env.TABLE.idFromName('clan')); // un seul clan par installation
    if (pathname === '/ws') return table.fetch(request);
    if (pathname === '/api/war' || pathname === '/api/status') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Méthode non autorisée.', { status: 405, headers: { Allow: 'GET, HEAD' } });
      }
      return table.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
