# Paso fix en {{repo}}

Estás en el repo `{{repo}}`, rama `{{branch}}`. Algo falló y te toca arreglarlo.

{{repoNotes}}

## Qué falló: {{reason}}

{{report}}

## Libro de tareas

Cada tarea es un commit.

{{ledger}}

## Spec

{{spec}}

## Cómo trabajar

1. Encuentra la causa y arréglala ahí. No tapes el síntoma: nada de saltear tests, `any`, `eslint-disable` ni aflojar un test, salvo que el test esté mal y lo puedas justificar en `notes`.
2. Arregla lo mínimo. En lint, solo los errores que lista el reporte, en líneas que tocó la rama: no reformatees el resto del archivo.
3. Cada arreglo va como fixup del commit de la tarea a la que pertenece: `git add <archivos>` y `git commit --fixup=<sha>`. El flujo los aplasta antes de abrir la PR. Si el arreglo toca dos tareas, haz dos fixups.
4. No reescribas historia: sin rebase, reset, amend ni checkout. No dejes nada sin commitear.
5. Verifica con los checks del repo:

{{checks}}

6. `fixed`: true solo si lo que falló ahora pasa. Si no se puede arreglar sin cambiar el alcance, `fixed: false` y explica por qué en `notes`.
