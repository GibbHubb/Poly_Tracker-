-- All geometries SRID 4326. UUID PKs default via gen_random_uuid() (pgcrypto).

CREATE TABLE farms (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text NOT NULL,
    owner      text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE paddocks (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    farm_id    uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
    name       text NOT NULL,
    geom       geometry(Polygon, 4326),
    notes      text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE poly_runs (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    farm_id        uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
    name           text NOT NULL,
    geom           geometry(LineString, 4326),
    diameter_mm    int,
    depth_m        numeric,
    material       text,
    installed_date date,
    notes          text,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE features (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    farm_id    uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
    type       text NOT NULL CHECK (type IN ('trough','turkey_nest','bore','gate','tank','other')),
    name       text,
    geom       geometry(Point, 4326),
    notes      text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE photos (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    feature_type text,
    feature_id   uuid,
    path         text NOT NULL,
    taken_at     timestamptz,
    lat          numeric,
    lng          numeric
);

CREATE INDEX paddocks_geom_gist  ON paddocks  USING GIST (geom);
CREATE INDEX poly_runs_geom_gist ON poly_runs USING GIST (geom);
CREATE INDEX features_geom_gist  ON features  USING GIST (geom);

CREATE INDEX paddocks_farm_idx  ON paddocks  (farm_id);
CREATE INDEX poly_runs_farm_idx ON poly_runs (farm_id);
CREATE INDEX features_farm_idx  ON features  (farm_id);
