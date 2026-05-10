from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

import numpy as np
import orjson
import pandas as pd
import pytest

from ktx_daemon.code_execution import (
    ExecuteCodeRequest,
    create_scratchpad_helpers,
    detect_visualizations,
    dumps_numpy_json,
    execute_code_response,
)


@dataclass
class FakeResponse:
    json_payload: dict[str, Any] | None = None
    content: bytes = b""
    headers: dict[str, str] | None = None

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self.json_payload or {}


class FakeHttpClient:
    def __init__(self) -> None:
        self.posts: list[dict[str, Any]] = []
        self.gets: list[dict[str, Any]] = []

    def post(
        self,
        url: str,
        data: bytes,
        headers: dict[str, str],
        timeout: int,
    ) -> FakeResponse:
        self.posts.append(
            {
                "url": url,
                "data": orjson.loads(data),
                "headers": headers,
                "timeout": timeout,
            }
        )
        return FakeResponse(json_payload={"filename": "saved.json"})

    def get(
        self,
        url: str,
        headers: dict[str, str],
        timeout: int,
    ) -> FakeResponse:
        self.gets.append({"url": url, "headers": headers, "timeout": timeout})
        return FakeResponse(
            content=b"value,name\n1.25,alpha\n",
            headers={"content-type": "text/csv; charset=utf-8"},
        )


def test_execute_code_response_captures_console_result_and_strips_ansi() -> None:
    response = execute_code_response(
        ExecuteCodeRequest(
            code='print("\\x1b[31mhello\\x1b[0m")\nresult = {"value": 3}',
        ),
        nest_api_url=None,
        auth_header=None,
    )

    assert response.result == {"value": 3}
    assert response.console_output == "\x1b[31mhello\x1b[0m\n"
    assert "=== Console Output ===" in response.formatted_result
    assert "hello" in response.formatted_result
    assert "\x1b" not in response.formatted_result
    assert "=== Result ===" in response.formatted_result


def test_execute_code_response_returns_message_when_result_is_absent() -> None:
    response = execute_code_response(
        ExecuteCodeRequest(code='print("ran")'),
        nest_api_url=None,
        auth_header=None,
    )

    assert response.result is None
    assert (
        response.message == "Code executed successfully but no result variable was set"
    )
    assert response.console_output == "ran\n"
    assert "=== Message ===" in response.formatted_result


def test_execute_code_response_detects_visualization_records() -> None:
    response = execute_code_response(
        ExecuteCodeRequest(
            code="result = "
            + json.dumps(
                {
                    "type": "visualization",
                    "vis_type": "bar",
                    "config": {"title": "Revenue"},
                    "data": [{"month": "Jan", "revenue": 10}],
                    "title": "Revenue",
                }
            ),
        ),
        nest_api_url=None,
        auth_header=None,
    )

    assert response.visualizations is not None
    assert len(response.visualizations) == 1
    assert response.visualizations[0].vis_type == "bar"
    assert response.visualizations[0].title == "Revenue"


def test_detect_visualizations_filters_mixed_lists() -> None:
    visualizations = detect_visualizations(
        [
            {"type": "note", "text": "skip"},
            {
                "type": "visualization",
                "vis_type": "table",
                "config": {"title": "Rows"},
                "data": [{"row": 1}],
            },
        ]
    )

    assert visualizations == [
        {
            "type": "visualization",
            "vis_type": "table",
            "config": {"title": "Rows"},
            "data": [{"row": 1}],
        }
    ]


def test_scratchpad_and_visualization_helpers_serialize_numpy_scalars() -> None:
    client = FakeHttpClient()
    save_df, read_file, save_viz = create_scratchpad_helpers(
        nest_api_url="http://nest",
        auth_header="Bearer token",
        source_id="source_123",
        message_id="message_456",
        http_client=client,
    )

    df = pd.DataFrame({"value": [np.float64(1.25)]})
    assert save_df(df, filename="df.json") == "1 rows saved to saved.json"

    read_df = read_file("input.csv")
    assert read_df.to_dict(orient="records") == [{"value": 1.25, "name": "alpha"}]

    viz_ref = save_viz(
        vis_type="bar",
        config={"title": "Test", "x": "a", "y": np.float64(2.5)},
        data=[{"a": "row1", "b": np.float64(3.75)}],
    )
    assert viz_ref == "![viz](saved.json)"

    assert (
        client.posts[0]["url"] == "http://nest/private_api/scratchpad/source_123/files"
    )
    assert client.posts[0]["data"]["data"][0]["value"] == 1.25
    assert (
        client.gets[0]["url"]
        == "http://nest/private_api/scratchpad/source_123/files/input.csv?format=raw"
    )
    assert client.posts[1]["url"] == "http://nest/private_api/visualizations/source_123"
    assert client.posts[1]["data"]["config"]["y"] == 2.5
    assert client.posts[1]["data"]["data"][0]["b"] == 3.75


def test_scratchpad_helpers_require_app_context_only_when_called() -> None:
    save_df, read_file, save_viz = create_scratchpad_helpers(
        nest_api_url=None,
        auth_header=None,
        source_id=None,
        message_id=None,
    )

    with pytest.raises(ValueError, match="required for scratchpad operations"):
        save_df(pd.DataFrame({"value": [1]}), filename="df.json")

    with pytest.raises(ValueError, match="required for scratchpad operations"):
        read_file("df.csv")

    with pytest.raises(ValueError, match="required for visualization operations"):
        save_viz("bar", {"title": "Chart"}, [{"value": 1}])


def test_dumps_numpy_json_serializes_numpy_values() -> None:
    rendered = dumps_numpy_json(
        {
            "scalar": np.float64(1.5),
            "array": np.array([1, 2, 3]),
        }
    )

    assert orjson.loads(rendered) == {"scalar": 1.5, "array": [1, 2, 3]}
