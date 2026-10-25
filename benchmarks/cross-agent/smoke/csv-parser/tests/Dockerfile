FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94
WORKDIR /verify
COPY test.sh /tests/test.sh
COPY grade.mjs /tests/grade.mjs
RUN chmod 0555 /tests/test.sh && chmod 0444 /tests/grade.mjs
