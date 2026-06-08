import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/index.js';
import { truncateAll, closePool } from './helpers.js';

beforeEach(truncateAll);
afterAll(closePool);

describe('farms CRUD', () => {
  it('POST /api/farms creates a farm', async () => {
    const res = await request(app)
      .post('/api/farms')
      .send({ name: 'Test Farm' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Test Farm');
    expect(typeof res.body.id).toBe('string');
  });

  it('GET /api/farms lists farms', async () => {
    await request(app).post('/api/farms').send({ name: 'Farm A' });
    await request(app).post('/api/farms').send({ name: 'Farm B' });
    const res = await request(app).get('/api/farms');
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(2);
  });

  it('GET /api/farms/:id returns the farm', async () => {
    const created = (await request(app).post('/api/farms').send({ name: 'Solo' })).body;
    const res = await request(app).get(`/api/farms/${created.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.id);
  });

  it('GET /api/farms/:id returns 404 for unknown id', async () => {
    const res = await request(app).get('/api/farms/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });

  it('PATCH /api/farms/:id updates name', async () => {
    const created = (await request(app).post('/api/farms').send({ name: 'Old' })).body;
    const res = await request(app)
      .patch(`/api/farms/${created.id}`)
      .send({ name: 'New' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('New');
  });

  it('DELETE /api/farms/:id removes the farm', async () => {
    const created = (await request(app).post('/api/farms').send({ name: 'Goodbye' })).body;
    const del = await request(app).delete(`/api/farms/${created.id}`);
    expect(del.status).toBe(204);
    const get = await request(app).get(`/api/farms/${created.id}`);
    expect(get.status).toBe(404);
  });
});
