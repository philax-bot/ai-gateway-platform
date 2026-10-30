"""Run the pinned Octop CLI with network access restricted to loopback for QA."""
import ipaddress
import runpy
import socket
import os

_connect = socket.socket.connect
_connect_ex = socket.socket.connect_ex
_getaddrinfo = socket.getaddrinfo


def allowed(address):
    if not isinstance(address, tuple):
        raise OSError("Octop QA permits only loopback TCP connections")
    host = address[0]
    if host == "localhost":
        return
    try:
        if ipaddress.ip_address(host).is_loopback:
            return
    except ValueError:
        pass
    raise OSError("Octop QA blocked a non-loopback connection")


def connect(self, address):
    allowed(address)
    return _connect(self, address)


def connect_ex(self, address):
    allowed(address)
    return _connect_ex(self, address)


def getaddrinfo(host, port, *args, **kwargs):
    if host is not None:
        allowed((host, port))
    return _getaddrinfo(host, port, *args, **kwargs)


socket.socket.connect = connect
socket.socket.connect_ex = connect_ex
socket.getaddrinfo = getaddrinfo
if os.environ.get("OCTOP_GATEWAY_COMPAT") == "1":
    from octop_gateway_compat import install
    install()
runpy.run_module("octop", run_name="__main__")
