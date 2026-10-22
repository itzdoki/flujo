# Paso release: PR de {{repo}}

Escribe el título y la descripción de la PR, en español.

## Título

`type(scope): qué cambia, en lenguaje llano ({{issueId}})`. Ejemplos:

- `feat(reports): exporta la base de clientes en xlsx (ENG-913)`
- `fix(devices): el desbloqueo siempre consulta al servicio de dispositivos antes de responder (ENG-906)`

## Descripción

- Primera línea: `Cierra {{issueId}}.` y una o dos frases de contexto sobre por qué existe este cambio.
- `## Qué hace`: bullets concretos, con endpoints, clases o archivos en `código`.
- `## Pruebas`: qué tests se agregaron y qué se corrió, con los resultados de abajo.
- `## Para revisar`: solo si hay supuestos, desvíos del plan u observaciones abiertas de la revisión automática.
- Concreto y llano, sin relleno. No agregues pie ni firma.

## Manda el código

Describe el código como quedó en el diff final, no lo que proponía el spec. Las notas de los implementadores se escribieron antes de los fixes y pueden estar viejas. Si el spec o las notas contradicen el diff, manda el diff: no menciones lo que el diff no muestra.

Diff final contra la base, después de aplastar los fixups: `{{diffFile}}`. Léelo antes de escribir.

Los checks del flujo pasaron sobre la rama final: {{checksPassed}}.

## Material

Ticket: {{issueId}}, {{issueTitle}}

### Spec

{{spec}}

### Commits

{{commits}}

### Desvíos que reportaron los implementadores

{{deviations}}

### Criterios de aceptación ejecutados

{{acceptance}}

### Observaciones abiertas de la revisión automática

{{openFindings}}
