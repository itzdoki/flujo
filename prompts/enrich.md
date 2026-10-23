# Paso enrich

Prepara el terreno para que otros agentes implementen este ticket sin inventar nada. No escribes código.

## Ticket

{{issue}}

## Repos

Estás en `{{reposDir}}`. Cada carpeta es un clon actualizado en su rama base:

{{repos}}

## Qué hacer

1. Lee el ticket completo: descripción, criterios de aceptación, comentarios, issue padre y sub-issues.
2. Recorre el código. No preguntes: mira. Encuentra dónde vive lo que hay que cambiar, qué código existente resuelve algo parecido, qué otras partes se ven afectadas y qué tests hay alrededor.
3. Escribe el spec en `spec_markdown`, con estas secciones:
   - **Objetivo**: qué cambia, en dos o tres frases.
   - **Alcance**: qué entra y qué queda fuera.
   - **Dónde**: archivos y funciones clave con `repo/ruta:línea`.
   - **Modelos a imitar**: código existente que hay que seguir.
   - **Criterios de aceptación**: los del ticket, escritos como comportamientos verificables.
   - **Casos borde**.
4. `repos`: solo los repos que hay que modificar.
5. `assumptions`: lo que decidiste porque el ticket no lo dice, uno por ítem. El flujo los agrega al final del spec.
6. `blocking_questions`: vacía, salvo que falte algo que no se puede deducir del ticket ni del código **y** equivocarse sea caro (dinero, datos de clientes, producción, contratos con otros equipos). Si un supuesto razonable alcanza, úsalo.
7. `estimate`: cuántas tareas (un commit cada una) y cuántos archivos distintos va a tocar el plan, contando los nuevos pero **no** los de test (`*.spec.*`, `*.test.*`, `__tests__/`). Estima con lo que viste en el código, sin redondear para abajo: si se pasa del límite, el flujo frena antes de planificar para que una persona revise el spec.
