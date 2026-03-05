"""Tests for the DBFS reader module."""

import os
import tempfile

import pytest

from app.engines.dbfs_reader import is_dbfs_path, normalize_dbfs_path, read_file


class TestIsDbfsPath:
    def test_dbfs_colon_prefix(self):
        assert is_dbfs_path("dbfs:/landing/file.zip") is True

    def test_dbfs_slash_prefix(self):
        assert is_dbfs_path("/dbfs/landing/file.zip") is True

    def test_local_path(self):
        assert is_dbfs_path("/tmp/file.zip") is False

    def test_relative_path(self):
        assert is_dbfs_path("file.zip") is False


class TestNormalizeDbfsPath:
    def test_dbfs_colon(self):
        assert normalize_dbfs_path("dbfs:/landing/file.zip") == "/landing/file.zip"

    def test_dbfs_slash(self):
        assert normalize_dbfs_path("/dbfs/landing/file.zip") == "/landing/file.zip"

    def test_already_normalized(self):
        assert normalize_dbfs_path("/landing/file.zip") == "/landing/file.zip"

    def test_nested_path(self):
        assert normalize_dbfs_path("dbfs:/a/b/c/d.zip") == "/a/b/c/d.zip"


class TestReadFileLocal:
    def test_read_local_file(self, tmp_path):
        test_file = tmp_path / "test.xml"
        test_file.write_bytes(b"<xml>hello</xml>")
        data = read_file(str(test_file))
        assert data == b"<xml>hello</xml>"

    def test_read_nonexistent_file(self, tmp_path):
        with pytest.raises(FileNotFoundError):
            read_file(str(tmp_path / "nonexistent.xml"))

    def test_read_empty_file(self, tmp_path):
        test_file = tmp_path / "empty.xml"
        test_file.write_bytes(b"")
        data = read_file(str(test_file))
        assert data == b""

    def test_read_binary_content(self, tmp_path):
        content = b"PK\x03\x04" + b"\x00" * 100
        test_file = tmp_path / "test.zip"
        test_file.write_bytes(content)
        data = read_file(str(test_file))
        assert data == content
