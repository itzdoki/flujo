# Paso implement: tarea {{taskId}}

Estás en el repo `{{repo}}`, rama `{{branch}}`, que sale de `{{base}}`.

{{repoNotes}}

## Tu tarea

**{{taskTitle}}**

{{taskInstructions}}

Archivos previstos: {{taskFiles}}

Mensaje de commit sugerido: `{{commitMessage}}`

## Contexto

### Spec

{{spec}}

### Plan completo

Solo para que entiendas el conjunto. Las otras tareas las hacen otros agentes.

{{planOutline}}

### Libro de tareas: lo que ya está hecho

{{ledger}}

## Cómo trabajar

1. Lee el `CLAUDE.md` del repo y el código que la tarea manda imitar antes de escribir.
2. Implementa **solo esta tarea**, con sus tests. No adelantes trabajo de otras tareas.
3. Verifica antes de commitear:

{{checks}}

   El lint cuenta solo los errores que agrega tu cambio: no arregles ni reformatees lo que ya estaba mal en el archivo.

4. Haz un solo commit: `git add` de los archivos que tocaste y `git commit -m "<mensaje>"`. El mensaje va en inglés con conventional commits; ajusta el sugerido si cambió el alcance. Sin `--amend` ni `--no-verify`. No dejes nada sin commitear.
5. Si algo del plan está mal o no se puede hacer como dice, resuelve lo más razonable y explícalo en `deviations`.
6. `done`: true solo si el commit está hecho y los checks pasan.
