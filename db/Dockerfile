FROM postgis/postgis:16-3.4

# init/*.sql is executed alphabetically on first container start
COPY init/ /docker-entrypoint-initdb.d/
