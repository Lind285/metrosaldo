"""
MetroSaldo - Generación del dataset SINTÉTICO de consumo diario.

IMPORTANTE: los datos de este archivo son simulados. No corresponden a
personas reales ni a registros del sistema oficial del Metropolitano.
Sirven para construir y evaluar el modelo mientras no existan datos reales
recogidos con la app (prueba piloto).

Supuestos de la simulación (todos configurables abajo):
- Tarifas 2026 (fuente: ATU, difundidas en prensa, oct. 2026):
    general:      troncal S/ 3.20 | integrada (alimentador + troncal) S/ 3.50
    universitaria: troncal S/ 1.60 | integrada S/ 1.75
- Periodo simulado: 17/08/2026 al 13/12/2026 (17 semanas).
- Cada estudiante tiene días de clase fijos, probabilidad de viajar
  en días de clase y en otros días, y 1 a 3 viajes por día de viaje.
- Feriados del periodo tratados como domingo: 30/08, 08/10, 01/11, 08/12.
"""
import numpy as np
import pandas as pd
from datetime import date, timedelta

SEMILLA = 42
N_ESTUDIANTES = 80
FECHA_INICIO = date(2026, 8, 17)
FECHA_FIN = date(2026, 12, 13)
FERIADOS = {date(2026, 8, 30), date(2026, 10, 8), date(2026, 11, 1), date(2026, 12, 8)}

TARIFAS = {
    "universitaria": {"troncal": 1.60, "integrada": 1.75},
    "general": {"troncal": 3.20, "integrada": 3.50},
}
PROP_UNIVERSITARIA = 0.80   # la mayoría del segmento objetivo tiene medio pasaje
PROP_USA_INTEGRADA = 0.35   # estudiantes que suelen combinar alimentador + troncal

rng = np.random.default_rng(SEMILLA)


def crear_perfil(i):
    tarifa = "universitaria" if rng.random() < PROP_UNIVERSITARIA else "general"
    usa_integrada = rng.random() < PROP_USA_INTEGRADA
    n_dias_clase = rng.choice([3, 4, 5, 6], p=[0.20, 0.35, 0.35, 0.10])
    dias_clase = sorted(rng.choice(6, size=n_dias_clase, replace=False).tolist())  # 0=lun ... 5=sab
    return {
        "id_estudiante": f"E{i:03d}",
        "tipo_tarifa": tarifa,
        "usa_integrada": usa_integrada,
        "dias_clase": dias_clase,
        "p_viaja_clase": rng.uniform(0.85, 0.98),
        "p_viaja_otro_laborable": rng.uniform(0.05, 0.25),
        "p_viaja_sabado": rng.uniform(0.10, 0.35),
        "p_viaja_domingo": rng.uniform(0.03, 0.20),
    }


def simular(perfil):
    filas = []
    d = FECHA_INICIO
    tarifas = TARIFAS[perfil["tipo_tarifa"]]
    while d <= FECHA_FIN:
        dow = d.weekday()  # 0=lunes ... 6=domingo
        feriado = d in FERIADOS
        if feriado or dow == 6:
            p = perfil["p_viaja_domingo"]
        elif dow in perfil["dias_clase"]:
            p = perfil["p_viaja_clase"]
        elif dow == 5:
            p = perfil["p_viaja_sabado"]
        else:
            p = perfil["p_viaja_otro_laborable"]
        viajes_troncal = viajes_integrada = 0
        if rng.random() < p:
            n_viajes = rng.choice([1, 2, 3], p=[0.10, 0.80, 0.10])
            for _ in range(n_viajes):
                if perfil["usa_integrada"] and rng.random() < 0.80:
                    viajes_integrada += 1
                else:
                    viajes_troncal += 1
        gasto = viajes_troncal * tarifas["troncal"] + viajes_integrada * tarifas["integrada"]
        filas.append({
            "id_estudiante": perfil["id_estudiante"],
            "fecha": d.isoformat(),
            "dia_semana": dow,
            "es_fin_de_semana": int(dow >= 5),
            "es_feriado": int(feriado),
            "tipo_tarifa": perfil["tipo_tarifa"],
            "tarifa_troncal": tarifas["troncal"],
            "viajes_troncal": viajes_troncal,
            "viajes_integrada": viajes_integrada,
            "gasto_dia": round(gasto, 2),
        })
        d += timedelta(days=1)
    return filas


if __name__ == "__main__":
    perfiles = [crear_perfil(i) for i in range(1, N_ESTUDIANTES + 1)]
    filas = []
    for p in perfiles:
        filas.extend(simular(p))
    df = pd.DataFrame(filas)
    df.to_csv("dataset_sintetico_metrosaldo.csv", index=False)
    pd.DataFrame([{**p, "dias_clase": ",".join(map(str, p["dias_clase"]))} for p in perfiles]) \
        .to_csv("perfiles_simulados.csv", index=False)
    print(f"Registros: {len(df)} | Estudiantes: {df.id_estudiante.nunique()} | Días: {df.fecha.nunique()}")
    print(df.head())
