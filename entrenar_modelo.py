"""
MetroSaldo - Preparación de datos, entrenamiento y evaluación.

Problema: REGRESIÓN. Se estima el gasto del día siguiente (S/) de un estudiante
a partir de su historial reciente y del calendario. Con esa estimación se
calcula la fecha aproximada en que el saldo dejará de cubrir un pasaje.

Modelos comparados (sílabo: regresión lineal y árbol de decisión):
  - Línea base: promedio del gasto diario de los últimos 7 días.
  - Regresión lineal (modelo principal).
  - Árbol de decisión para regresión (modelo de comparación).

Protocolo: partición por estudiante (70 % / 15 % / 15 %) para que un mismo
estudiante no aparezca en entrenamiento y prueba. El árbol se ajusta con el
conjunto de validación; el conjunto de prueba se usa una sola vez al final.
"""
import json
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from sklearn.linear_model import LinearRegression
from sklearn.tree import DecisionTreeRegressor, export_text
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

SEMILLA = 42
SALDO_INICIAL_PRUEBA = 20.00   # recarga típica usada para evaluar la fecha de agotamiento
HORIZONTE_MAX = 60
DIAS = ["lun", "mar", "mie", "jue", "vie", "sab", "dom"]

df = pd.read_csv("dataset_sintetico_metrosaldo.csv", parse_dates=["fecha"])
df = df.sort_values(["id_estudiante", "fecha"]).reset_index(drop=True)

# ------------------------------------------------------------------ 1. EDA
print("=== Datos ===")
print("Registros:", len(df), "| Estudiantes:", df.id_estudiante.nunique())
print("Faltantes:", int(df.isna().sum().sum()), "| Duplicados:", int(df.duplicated(["id_estudiante", "fecha"]).sum()))
print("Días sin viaje: %.1f %%" % (100 * (df.gasto_dia == 0).mean()))
print(df.gasto_dia.describe().round(2))

fig, ax = plt.subplots(figsize=(7, 4))
df.groupby("dia_semana").gasto_dia.mean().rename(index=dict(enumerate(DIAS))).plot.bar(ax=ax, color="#C8102E")
ax.set_ylabel("Gasto promedio (S/)"); ax.set_xlabel("Día de la semana"); ax.set_title("Gasto diario promedio por día de la semana")
plt.tight_layout(); plt.savefig("fig1_gasto_por_dia.png", dpi=150); plt.close()

fig, ax = plt.subplots(figsize=(7, 4))
ax.hist(df.gasto_dia, bins=20, color="#333333")
ax.set_xlabel("Gasto del día (S/)"); ax.set_ylabel("Frecuencia"); ax.set_title("Distribución del gasto diario")
plt.tight_layout(); plt.savefig("fig2_distribucion_gasto.png", dpi=150); plt.close()

# ------------------------------------------------------------------ 2. Variables (solo con información pasada)
def crear_variables(g):
    g = g.copy()
    pasado = g.gasto_dia.shift(1)
    g["prom_gasto_7d"] = pasado.rolling(7).mean()
    g["dias_con_viaje_7d"] = (pasado > 0).astype(float).rolling(7).sum()
    g["prom_mismo_dia_4sem"] = g.groupby("dia_semana").gasto_dia.transform(lambda s: s.shift(1).rolling(4).mean())
    return g

df = pd.concat([crear_variables(g) for _, g in df.groupby("id_estudiante")])
df = df.dropna(subset=["prom_gasto_7d", "dias_con_viaje_7d", "prom_mismo_dia_4sem"]).reset_index(drop=True)
for k in range(1, 7):
    df[f"dia_{DIAS[k]}"] = (df.dia_semana == k).astype(int)   # lunes es la categoría de referencia

VARIABLES = [f"dia_{d}" for d in DIAS[1:]] + ["es_feriado", "tarifa_troncal",
             "prom_gasto_7d", "prom_mismo_dia_4sem", "dias_con_viaje_7d"]
OBJETIVO = "gasto_dia"
print("Registros utilizables (con 4 semanas de historial):", len(df))

# ------------------------------------------------------------------ 3. Partición por estudiante
ids = np.array(sorted(df.id_estudiante.unique()))
np.random.default_rng(SEMILLA).shuffle(ids)
n = len(ids)
ids_train, ids_val, ids_test = ids[:int(.7 * n)], ids[int(.7 * n):int(.85 * n)], ids[int(.85 * n):]
tr, va, te = (df[df.id_estudiante.isin(s)] for s in (ids_train, ids_val, ids_test))
print(f"Estudiantes train/val/test: {len(ids_train)}/{len(ids_val)}/{len(ids_test)} | filas: {len(tr)}/{len(va)}/{len(te)}")


def metricas(y, p):
    return {"MAE": mean_absolute_error(y, p), "RMSE": mean_squared_error(y, p) ** 0.5, "R2": r2_score(y, p)}


# ------------------------------------------------------------------ 4. Ajuste en validación
res_val = {"Línea base (promedio 7 días)": metricas(va[OBJETIVO], va.prom_gasto_7d)}
lin = LinearRegression().fit(tr[VARIABLES], tr[OBJETIVO])
res_val["Regresión lineal"] = metricas(va[OBJETIVO], lin.predict(va[VARIABLES]))

mejor = None
for depth in [2, 3, 4, 5, 6, 8]:
    for leaf in [5, 20, 50]:
        arb = DecisionTreeRegressor(max_depth=depth, min_samples_leaf=leaf, random_state=SEMILLA).fit(tr[VARIABLES], tr[OBJETIVO])
        mae = mean_absolute_error(va[OBJETIVO], arb.predict(va[VARIABLES]))
        if mejor is None or mae < mejor[0]:
            mejor = (mae, depth, leaf)
print("Mejor árbol en validación: max_depth=%d, min_samples_leaf=%d (MAE=%.3f)" % (mejor[1], mejor[2], mejor[0]))
arb = DecisionTreeRegressor(max_depth=mejor[1], min_samples_leaf=mejor[2], random_state=SEMILLA).fit(tr[VARIABLES], tr[OBJETIVO])
res_val["Árbol de decisión"] = metricas(va[OBJETIVO], arb.predict(va[VARIABLES]))

# ------------------------------------------------------------------ 5. Modelos finales (train + val) y prueba única
trva = pd.concat([tr, va])
lin = LinearRegression().fit(trva[VARIABLES], trva[OBJETIVO])
arb = DecisionTreeRegressor(max_depth=mejor[1], min_samples_leaf=mejor[2], random_state=SEMILLA).fit(trva[VARIABLES], trva[OBJETIVO])
pred_test = {
    "Línea base (promedio 7 días)": te.prom_gasto_7d.values,
    "Regresión lineal": np.clip(lin.predict(te[VARIABLES]), 0, None),
    "Árbol de decisión": arb.predict(te[VARIABLES]),
}
res_test = {k: metricas(te[OBJETIVO], v) for k, v in pred_test.items()}

tabla = pd.DataFrame([{"Modelo": m, "Métrica": k, "Validación": round(res_val[m][k], 3), "Prueba": round(res_test[m][k], 3)}
                      for m in res_val for k in ["MAE", "RMSE", "R2"]])
print("\n=== Resultados: gasto diario (S/) ===")
print(tabla.to_string(index=False))
tabla.to_csv("resultados_gasto_diario.csv", index=False)

# ------------------------------------------------------------------ 6. Evaluación de la fecha de agotamiento (prueba)
def dias_hasta_agotar(gastos, tarifa):
    saldo = SALDO_INICIAL_PRUEBA
    for d, g in enumerate(gastos):
        saldo -= g
        if saldo < tarifa:
            return d
    return None


def predecir_gastos(modelo, hist, inicio, tarifa, n_dias):
    """Predice el gasto de los próximos n_dias usando solo la historia hasta 'inicio'.
    Las variables de historial se fijan en el día de inicio (igual que en la app)."""
    pasado = hist[hist.fecha < inicio]
    p7 = pasado.gasto_dia.tail(7).mean()
    v7 = (pasado.gasto_dia.tail(7) > 0).sum()
    filas = []
    for k in range(n_dias):
        f = inicio + pd.Timedelta(days=k)
        dow = f.weekday()
        mismo = pasado[pasado.dia_semana == dow].gasto_dia.tail(4).mean()
        fila = {f"dia_{DIAS[j]}": int(dow == j) for j in range(1, 7)}
        fila.update({"es_feriado": 0, "tarifa_troncal": tarifa, "prom_gasto_7d": p7,
                     "prom_mismo_dia_4sem": mismo, "dias_con_viaje_7d": v7})
        filas.append(fila)
    X = pd.DataFrame(filas)[VARIABLES]
    if modelo == "base":
        return np.full(n_dias, p7)
    return np.clip(modelo.predict(X), 0, None)


completo = pd.read_csv("dataset_sintetico_metrosaldo.csv", parse_dates=["fecha"])
errores = {k: [] for k in pred_test}
ejemplo = None
for uid in ids_test:
    h = completo[completo.id_estudiante == uid].sort_values("fecha").reset_index(drop=True)
    tarifa = h.tarifa_troncal.iloc[0]
    for i in range(35, len(h) - 30, 7):
        inicio = h.fecha.iloc[i]
        real = dias_hasta_agotar(h.gasto_dia.iloc[i:].values, tarifa)
        if real is None or real > 30:
            continue
        for nombre, modelo in [("Línea base (promedio 7 días)", "base"), ("Regresión lineal", lin), ("Árbol de decisión", arb)]:
            pg = predecir_gastos(modelo, h, inicio, tarifa, HORIZONTE_MAX)
            pred = dias_hasta_agotar(pg, tarifa)
            pred = HORIZONTE_MAX if pred is None else pred
            errores[nombre].append(abs(pred - real))
            if ejemplo is None and nombre == "Regresión lineal":
                ejemplo = (uid, inicio, h.gasto_dia.iloc[i:i + 30].values, pg[:30], tarifa)

tabla_fecha = pd.DataFrame([{"Modelo": k, "Casos evaluados": len(v), "MAE (días)": round(np.mean(v), 2),
                             "% con error <= 1 día": round(100 * np.mean(np.array(v) <= 1), 1)} for k, v in errores.items()])
print("\n=== Resultados: fecha de agotamiento con saldo inicial S/ %.2f (prueba) ===" % SALDO_INICIAL_PRUEBA)
print(tabla_fecha.to_string(index=False))
tabla_fecha.to_csv("resultados_fecha_agotamiento.csv", index=False)

# ------------------------------------------------------------------ 7. Gráficos de resultados
fig, ax = plt.subplots(figsize=(7, 4))
mae = tabla[tabla.Métrica == "MAE"]
ax.bar(mae.Modelo, mae.Prueba, color=["#999999", "#C8102E", "#333333"])
for i, v in enumerate(mae.Prueba):
    ax.text(i, v + 0.02, f"{v:.3f}", ha="center")
ax.set_ylabel("MAE en prueba (S/)"); ax.set_title("Comparación de modelos: error del gasto diario")
plt.tight_layout(); plt.savefig("fig3_comparacion_mae.png", dpi=150); plt.close()

p = pred_test["Regresión lineal"]
fig, ax = plt.subplots(figsize=(7, 4))
ax.scatter(p, te[OBJETIVO] - p, s=6, alpha=0.3, color="#C8102E")
ax.axhline(0, color="black", lw=1)
ax.set_xlabel("Gasto estimado (S/)"); ax.set_ylabel("Residuo: real - estimado (S/)"); ax.set_title("Residuos de la regresión lineal (prueba)")
plt.tight_layout(); plt.savefig("fig4_residuos_lineal.png", dpi=150); plt.close()

coef = pd.Series(lin.coef_, index=VARIABLES).sort_values()
fig, ax = plt.subplots(figsize=(7, 4.5))
coef.plot.barh(ax=ax, color=["#C8102E" if c < 0 else "#333333" for c in coef])
ax.set_xlabel("Coeficiente (S/ por unidad)"); ax.set_title("Coeficientes de la regresión lineal")
plt.tight_layout(); plt.savefig("fig5_coeficientes.png", dpi=150); plt.close()

if ejemplo:
    uid, inicio, real, pred, tarifa = ejemplo
    fig, ax = plt.subplots(figsize=(7, 4))
    sr = np.maximum(np.concatenate([[SALDO_INICIAL_PRUEBA], SALDO_INICIAL_PRUEBA - np.cumsum(real)]), 0)[:16]
    sp = np.maximum(np.concatenate([[SALDO_INICIAL_PRUEBA], SALDO_INICIAL_PRUEBA - np.cumsum(pred)]), 0)[:16]
    ax.plot(sr, marker="o", label="Saldo real (simulado)", color="#333333")
    ax.plot(sp, "--", marker="s", label="Saldo proyectado (regresión lineal)", color="#C8102E")
    ax.axhline(tarifa, color="gray", lw=1, ls=":", label=f"Tarifa troncal S/ {tarifa:.2f}")
    ax.set_xlabel(f"Días desde {inicio.date()}"); ax.set_ylabel("Saldo (S/)"); ax.legend()
    ax.set_title(f"Ejemplo de proyección del saldo ({uid}, conjunto de prueba)")
    plt.tight_layout(); plt.savefig("fig6_ejemplo_proyeccion.png", dpi=150); plt.close()

# ------------------------------------------------------------------ 8. Interpretabilidad y exportación para la app
print("\n=== Coeficientes de la regresión lineal ===")
print("intercepto:", round(lin.intercept_, 4))
for v, c in zip(VARIABLES, lin.coef_):
    print(f"  {v:22s} {c: .4f}")
print("\n=== Reglas del árbol (primeros niveles) ===")
print(export_text(arb, feature_names=VARIABLES, max_depth=3))

json.dump({
    "modelo": "LinearRegression (scikit-learn)",
    "objetivo": "gasto_dia (S/) del día a estimar",
    "variables": VARIABLES,
    "intercepto": float(lin.intercept_),
    "coeficientes": {v: float(c) for v, c in zip(VARIABLES, lin.coef_)},
    "nota": "Entrenado con datos SINTÉTICOS. La predicción se recorta a 0 si es negativa.",
}, open("modelo_regresion_lineal.json", "w"), indent=2, ensure_ascii=False)
print("Modelo exportado en modelo_regresion_lineal.json")
