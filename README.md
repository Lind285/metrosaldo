# MetroSaldo – Componente de Machine Learning (APF3)

Modelo que estima el gasto diario de un estudiante en el Metropolitano y con ello, la fecha aproximada en que su saldo dejará de cubrir un pasaje


## Archivos

| Archivo | Contenido |
|---|---|
| `generar_dataset.py` | Simula 80 estudiantes durante 119 días (17/08/2026 – 13/12/2026) |
| `entrenar_modelo.py` | Preparación, entrenamiento, evaluación, gráficos y exportación del modelo |
| `MetroSaldo_ML.ipynb` | Las mismas etapas en un notebook para Google Colab |
| `dataset_sintetico_metrosaldo.csv` | Dataset generado (9 520 registros) |
| `perfiles_simulados.csv` | Parámetros de cada estudiante simulado |
| `resultados_gasto_diario.csv` | MAE, RMSE y R² en validación y prueba |
| `resultados_fecha_agotamiento.csv` | Error en días de la fecha de agotamiento |
| `modelo_regresion_lineal.json` | Intercepto y coeficientes para usar en la app |
| `log_ejecucion.txt` | Salida completa de la ejecución |
| `fig1` … `fig6` | Gráficos para el informe |

## Cómo ejecutar

**Google Colab:** subir `MetroSaldo_ML.ipynb` y ejecutar todas las celdas. 
**Nuestro link:** https://colab.research.google.com/drive/1Xo_sxP7t0e1KhytM5UAHfHENDab6Tn7P
Dar click en el boton ejecutar todo.

La semilla es `42`, así que los resultados son reproducibles. Versiones usadas en la ejecución original: scikit-learn 1.9.1, pandas 3.0.6, numpy 2.5.4, matplotlib 3.11.2.

## Diseño

- **Tipo de problema:** regresión. La variable objetivo es `gasto_dia` (S/).
- **Variables de entrada** (todas calculadas solo con días anteriores, para evitar fuga de datos):
  - día de la semana (codificado en 6 variables binarias, con lunes como referencia);
  - `es_feriado`;
  - `tarifa_troncal`;
  - `prom_gasto_7d`;
  - `prom_mismo_dia_4sem`;
  - `dias_con_viaje_7d`.
- **Modelos comparados:**
  - **Línea base:** promedio del gasto de los últimos 7 días.
  - **Regresión lineal:** modelo principal.
  - **Árbol de decisión para regresión:** modelo de comparación.
- **Partición:** por estudiante, 56 para entrenamiento, 12 para validación y 12 para prueba. Así ningún estudiante aparece en entrenamiento y en prueba a la vez.
- **Ajuste del árbol:** `max_depth` y `min_samples_leaf` se eligieron con el conjunto de validación. El resultado fue `max_depth=5` y `min_samples_leaf=5`.
- **Evaluación final:** el conjunto de prueba se usó una sola vez.

## Resultados 

### Gasto diario

| Modelo | MAE (S/) | RMSE (S/) | R² |
|---|---|---|---|
| Línea base (promedio 7 días) | 1.506 | 1.706 | -0.027 |
| Regresión lineal | 1.030 | 1.363 | 0.345 |
| Árbol de decisión | 0.915 | 1.329 | 0.377 |

### Fecha de agotamiento

Se evaluaron 96 casos, todos con un saldo inicial de S/ 20.00.

| Modelo | MAE (días) | % de casos con error ≤ 1 día |
|---|---|---|
| Línea base | 3.29 | 33.3 % |
| Regresión lineal | 1.90 | 50.0 % |
| Árbol de decisión | 1.94 | 45.8 % |

**Decisión:** ambos modelos superan claramente a la línea base. Se elige la **regresión lineal** para la app por cuatro razones:

1. Su error en la fecha de agotamiento es prácticamente igual al del árbol (1.90 frente a 1.94 días).
2. Es más fácil de interpretar.
3. Se exporta como unos pocos coeficientes.
4. Puede calcularse dentro del celular sin conexión.
