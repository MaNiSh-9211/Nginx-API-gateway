# ============================================================
# eBPF/XDP Build — Ultra-Scale API Gateway L4 DDoS Filter
# ============================================================

CLANG   ?= clang
LLC     ?= llc
NIC     ?= eth0
OBJ      = xdp_ddos_filter.o

.PHONY: build load unload reload monitor clean

build: $(OBJ)

$(OBJ): xdp_ddos_filter.c
	$(CLANG) -O2 -target bpf \
		-I/usr/include/$(shell uname -m)-linux-gnu \
		-c $< -o $@
	@echo "Built $(OBJ)"

load: $(OBJ)
	ip link set dev $(NIC) xdp obj $(OBJ) sec xdp_ddos
	@echo "XDP filter loaded on $(NIC)"

unload:
	ip link set dev $(NIC) xdp off
	@echo "XDP filter unloaded from $(NIC)"

reload: unload load

# Show currently blocked IPs
monitor:
	@echo "=== Blocked IPs ==="
	bpftool map dump name blocked_ips 2>/dev/null || echo "(none)"
	@echo "=== SYN counters (top 10) ==="
	bpftool map dump name syn_counters 2>/dev/null | head -40

# Block an IP manually: make block IP=1.2.3.4
block:
	bpftool map update name blocked_ips key $(shell python3 -c "import socket,struct; print(' '.join(str(b) for b in struct.pack('>I', socket.ntohl(struct.unpack('I', socket.inet_aton('$(IP)'))[0]))))") value 0x01

clean:
	rm -f $(OBJ)
