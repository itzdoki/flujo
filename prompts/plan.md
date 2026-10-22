# Paso plan

Arma el plan que van a ejecutar agentes independientes. Cada uno ve solo su tarea, el spec y lo que ya hicieron los anteriores.

## Ticket

{{issue}}

## Spec

{{spec}}

## Repos a modificar

Estás en `{{reposDir}}`, con estos clones:

{{repos}}

## tasks

- Una tarea por cada lógica que se toca. Cada tarea es **un commit** y tiene que compilar sola. Ejemplos de cortes: «DTO + validación», «método de repositorio + spec», «servicio + wiring + specs», «endpoint + spec».
- En orden de ejecución: una tarea solo puede depender de las anteriores.
- `id`: `T1`, `T2`, …
- `instructions` autosuficientes: qué hacer, en qué archivos, qué código imitar (`ruta:línea`) y qué tests escribir o actualizar.
- Rutas en `instructions` y `files` relativas a la raíz del repo, sin el nombre del repo adelante: el implementador trabaja dentro del repo.
- `commit_message` en inglés, conventional commits: `type(scope): summary`.
- Sin pasos manuales, migraciones contra una base real, deploys ni cambios de infraestructura.

## acceptance

- Un ítem por criterio de aceptación del spec. `id`: `AC1`, `AC2`, …
- `command` sale con código 0 si y solo si el criterio se cumple. Corre en la raíz del repo indicado y **sin shell**: nada de `|`, `&&`, `;`, `$`, `>`, `<` ni backticks.
- Tiene que empezar con alguno de: {{allow}}.
- Prefiere tests puntuales (la ruta del spec y `-t "nombre del test"`) a la suite entera. Si el test todavía no existe, alguna tarea tiene que escribirlo y sus `instructions` lo dicen, con el nombre exacto del test.
- Un comando de tests que no corre ningún test cuenta como falla, y con `-t` también cuenta como falla si alguno de los archivos listados no tiene un test con ese nombre. Mejor un ítem por archivo que un `-t` sobre varios.

Además, el flujo corre estos checks en cada repo (no hace falta repetirlos como criterios):

{{checks}}

## risks

Lo que puede salir mal o lo que una persona debería mirar con atención.

{{retry}}
