// One command that works on any host, with no terminal needed:
//   1. applies database migrations (safe to repeat)
//   2. loads the fictional demo companies if SEED_DEMO=true
//   3. makes ADMIN_EMAIL an admin, if that person has already registered
//   4. starts the API
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Add it in your host\'s environment variables.');
  process.exit(1);
}

try {
  const args = [path.join(here, 'migrate.js'), ...(process.env.SEED_DEMO === 'true' ? ['--demo'] : [])];
  execFileSync(process.execPath, args, { stdio: 'inherit' });
} catch {
  console.error('Database setup failed (see the lines above). Not starting the API.');
  process.exit(1);
}

const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
if (adminEmail) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    const { rowCount } = await client.query(`UPDATE users SET role = 'ADMIN' WHERE email = $1`, [adminEmail]);
    console.log(rowCount ? `Admin: ${adminEmail} is an admin.` : `Admin: no account for ${adminEmail} yet. Register on the site, then restart this service.`);
  } catch (e) {
    console.error('Admin step skipped:', e.message);
  } finally {
    await client.end().catch(() => {});
  }
}

await import('../src/server.js');
