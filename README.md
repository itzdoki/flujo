# flujo

Lleva una issue de Linear hasta PRs en draft. Es un programa en TypeScript que llama a Claude Code en modo headless (`claude -p`) una vez por paso. Cada paso es un proceso nuevo, con su modelo, su esfuerzo y sus herramientas. Los pasos se pasan el trabajo por archivos.

> La IA computa. El código coordina.

## Pasos

| Fase | Quién | Modelo / esfuerzo | Qué deja |
|---|---|---|---|
| enrich | agente, solo lectura | sonnet / medium | `spec.md`; o preguntas en Linear si falta algo caro de suponer |
| plan | agente, solo lectura | opus / high | `plan.json`: tareas (una por commit) y criterios de aceptación como comandos |
| implement | un agente por tarea | sonnet / xhigh | un commit por tarea; después corre el typecheck |
| check | código | — | typecheck, lint y tests de lo tocado |
| review | agente, solo lectura | opus / high | hallazgos; los `blocker`/`major` vuelven a un agente de fix |
| qa | código | — | corre los comandos del plan; si fallan, fix y de nuevo |
| release | agente + código | haiku / high | aplasta los fixups, verifica que cada commit compile solo, push y PR en draft |
| qaNotes | agente | sonnet / high | guion de pruebas manuales como comentario en la issue |

El que verifica nunca arregla. Cada falla va a un agente de fix (sonnet / high), que la corrige con `git commit --fixup` sobre el commit de su tarea. Hay un tope de rondas (`maxFixRounds`) y, si se pasa, la corrida queda en `failed`.

Los modelos y los esfuerzos están en `config/flujo.json`. Los repos sobre los que trabaja, con sus comandos, van en `~/.config/flujo/repos.json`, fuera de este repo.

## Qué nunca hace

- Mergear, pasar una PR a ready ni pedir reviewers. Las PRs nacen en draft y ahí quedan.
- Tocar producción, bases de datos, CLIs de nube ni la red. Hay un deny explícito en cada llamada.
- Trabajar sobre una rama que ya existe en GitHub.
- Tocar tus carpetas de `~/Work`. Usa sus propios clones en `~/.local/share/flujo/repos`.
- Cargar tu `~/.claude/settings.json`. Corre con `--setting-sources project`, así que no hereda tus permisos ni tus hooks.
- Tomar issues que no estén asignadas a ti.

Lo único que publica: la rama, la PR en draft y comentarios en la issue (preguntas o guion de QA).

## Instalación

1. Crea una API key personal de Linear (Settings → Security & access → Personal API keys) y guárdala:

   ```sh
   mkdir -p ~/.config/flujo
   printf 'LINEAR_API_KEY=lin_api_...\n' > ~/.config/flujo/env
   chmod 600 ~/.config/flujo/env
   ```

   Opcional: `SLACK_WEBHOOK_URL=...` en el mismo archivo para avisos por Slack. Sin eso avisa con `notify-send`.

2. Declara tus repos copiando el ejemplo y ajustándolo:

   ```sh
   cp config/repos.example.json ~/.config/flujo/repos.json
   ```

   Cada repo lleva su URL, su rama base y los comandos de instalación, typecheck, lint y tests. `{files}` se reemplaza por los archivos que tocó la rama. `notes` entra en el prompt de los pasos que trabajan en ese repo.

3. Instala dependencias de desarrollo: `npm install`.

4. El timer, que toma una issue cada 30 minutos:

   ```sh
   mkdir -p ~/.config/systemd/user
   ln -sf ~/Work/flujo/systemd/flujo-poll.{service,timer} ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now flujo-poll.timer
   ```

   Para que corra con la sesión cerrada (pero la compu prendida): `loginctl enable-linger $USER`.

## Uso

- **Dejarle una tarea**: asígnate la issue y ponle la etiqueta `flujo`.
- `node src/cli.ts run ENG-123`: corre una issue a mano. Retoma donde quedó.
- `node src/cli.ts run ENG-123 --until plan`: se detiene después de una fase. Sirve para revisar el spec y el plan antes de dejarlo implementar.
- `node src/cli.ts run ENG-123 --fresh`: archiva la corrida anterior y empieza de cero.
- `node src/cli.ts run X-1 --issue-file issue.json`: modo local. No lee ni escribe Linear, no pushea ni abre PRs.
- `node src/cli.ts status [ENG-123]`: estado de las corridas y su log.

Estados: `running`, `blocked` (dejó preguntas; se retoma cuando hay actividad nueva en la issue), `paused` (límite de uso; se retoma en el siguiente ciclo), `stopped` (`--until`), `failed` (espera a una persona) y `done`.

Todo queda en `~/.local/share/flujo/runs/<ISSUE>/`: el estado, el log, el spec, el plan, los diffs, la revisión, los resultados de aceptación y cada llamada al modelo con su prompt y su costo (`calls/`).

## Cada error se corrige una vez

Cuando un paso se equivoca, no corrijas solo el código: agrega una lección al paso que falló.

```sh
node src/cli.ts lesson implement "En api los repositorios nuevos van con su spec de integración, no solo unitario"
```

La lección queda en `lessons/<paso>.md` y entra en el prompt de ese paso en todas las corridas siguientes. Si un problema se repite, el arreglo va en el prompt (`prompts/`) o en el código del flujo.
