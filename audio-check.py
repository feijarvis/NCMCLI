import ctypes, uuid, sys, time
from ctypes import (POINTER, byref, c_void_p, c_int, c_uint, c_float, c_wchar_p, Structure,
                    WINFUNCTYPE, c_ulong, c_ushort, c_ubyte)
ole32 = ctypes.WinDLL('ole32')
class GUID(Structure):
    _fields_ = [('Data1', c_ulong), ('Data2', c_ushort), ('Data3', c_ushort), ('Data4', c_ubyte * 8)]
    def __init__(self, s):
        u = uuid.UUID(s)
        super().__init__(u.time_low, u.time_mid, u.time_hi_version, (c_ubyte * 8)(*u.bytes[8:]))
def m(iface, idx, *argtypes):
    vt = ctypes.cast(iface, POINTER(POINTER(c_void_p))).contents
    return WINFUNCTYPE(c_int, c_void_p, *argtypes)(vt[idx])
def qi(iface, iid):
    out = c_void_p(); m(iface, 0, POINTER(GUID), c_void_p)(iface, byref(iid), byref(out)); return out
ole32.CoInitialize(None)
CLSID_MMDE = GUID('{BCDE0395-E52F-467C-8E3D-C4579291692E}')
IID_MMDE   = GUID('{A95664D2-9614-4F35-A746-DE8DB63617E6}')
IID_ASM2   = GUID('{77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F}')
IID_ASC2   = GUID('{BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D}')
IID_METER  = GUID('{C02216F6-8C67-4B5B-9D00-D008E73E0064}')
enum = c_void_p(); ole32.CoCreateInstance(byref(CLSID_MMDE), None, 1, byref(IID_MMDE), byref(enum))
dev = c_void_p(); m(enum, 4, c_int, c_int, POINTER(c_void_p))(enum, 0, 0, byref(dev))
asm = c_void_p(); m(dev, 3, POINTER(GUID), c_uint, c_void_p, POINTER(c_void_p))(dev, byref(IID_ASM2), 1, None, byref(asm))
senum = c_void_p(); m(asm, 5, POINTER(c_void_p))(asm, byref(senum))
cnt = c_int(); m(senum, 3, POINTER(c_int))(senum, byref(cnt))
rows = []
for i in range(cnt.value):
    ctl = c_void_p(); m(senum, 4, c_int, POINTER(c_void_p))(senum, i, byref(ctl))
    state = c_int(); m(ctl, 3, POINTER(c_int))(ctl, byref(state))
    ctl2 = qi(ctl, IID_ASC2)
    pid = c_uint(); m(ctl2, 13, POINTER(c_uint))(ctl2, byref(pid))
    sptr = c_wchar_p(); m(ctl2, 12, POINTER(c_wchar_p))(ctl2, byref(sptr))
    meter = qi(ctl, IID_METER)
    rows.append((pid.value, state.value, meter, sptr.value or ""))
def peaks():
    out = []
    for pid, st, meter, inst in rows:
        p = c_float(); m(meter, 3, POINTER(c_float))(meter, byref(p)); out.append(round(p.value, 4))
    return out
for _ in range(3):
    print("peaks:", peaks()); time.sleep(1.2)
print("---")
for pid, st, meter, inst in rows:
    if st == 1:
        print("ACTIVE pid=%d inst=%s" % (pid, inst))
