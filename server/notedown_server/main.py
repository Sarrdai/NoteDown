"""Entry point for uvicorn: `uvicorn notedown_server.main:app`."""

from .app import Settings, create_app

app = create_app(Settings.from_env())
