import 'dotenv/config';
import { createApp } from './app';
void createApp().then(app => app.listen(Number(process.env.PORT ?? 3100), '0.0.0.0')).catch(error => { console.error(error.message); process.exitCode = 1; });
