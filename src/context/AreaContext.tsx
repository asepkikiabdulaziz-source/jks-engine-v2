import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

interface Region  { id: string; kd_region: string; nama_region: string }
interface Cabang  { id: string; kd_cabang: string; nama_cabang: string }
export interface ActiveArea {
  id: string
  kd_dist: string
  nama_area: string
  lat: number
  lon: number
  cabang: Cabang
  region: Region
}

interface AreaState {
  activeArea: ActiveArea | null
  setActiveArea: (area: ActiveArea | null) => void
  // data untuk picker
  regions: Region[]
  cabangs: Cabang[]
  areas: { id: string; kd_dist: string; nama_area: string; lat: number; lon: number }[]
  selectedRegion: Region | null
  selectedCabang: Cabang | null
  setSelectedRegion: (r: Region | null) => void
  setSelectedCabang: (c: Cabang | null) => void
  loadingCabangs: boolean
  loadingAreas: boolean
}

const AreaContext = createContext<AreaState>({
  activeArea: null, setActiveArea: () => {},
  regions: [], cabangs: [], areas: [],
  selectedRegion: null, selectedCabang: null,
  setSelectedRegion: () => {}, setSelectedCabang: () => {},
  loadingCabangs: false, loadingAreas: false,
})

export function AreaProvider({ children }: { children: React.ReactNode }) {
  const [regions, setRegions]           = useState<Region[]>([])
  const [cabangs, setCabangs]           = useState<Cabang[]>([])
  const [areas,   setAreas]             = useState<AreaState['areas']>([])
  const [selectedRegion, setSelectedRegion] = useState<Region | null>(null)
  const [selectedCabang, setSelectedCabang] = useState<Cabang | null>(null)
  const [activeArea,     setActiveArea]     = useState<ActiveArea | null>(null)
  const [loadingCabangs, setLoadingCabangs] = useState(false)
  const [loadingAreas,   setLoadingAreas]   = useState(false)

  // Regions sekali load
  useEffect(() => {
    supabase.rpc('get_routing_regions').then(({ data }) => {
      if (data) setRegions(data as Region[])
    })
  }, [])

  // Cabangs saat region berubah
  useEffect(() => {
    setCabangs([]); setSelectedCabang(null); setAreas([])
    if (!selectedRegion) return
    setLoadingCabangs(true)
    supabase.rpc('get_routing_cabangs', { p_region_id: selectedRegion.id }).then(({ data }) => {
      if (data) setCabangs(data as Cabang[])
      setLoadingCabangs(false)
    })
  }, [selectedRegion])

  // Areas saat cabang berubah
  useEffect(() => {
    setAreas([])
    if (!selectedCabang) return
    setLoadingAreas(true)
    supabase.rpc('get_routing_areas', { p_cabang_id: selectedCabang.id }).then(({ data }) => {
      if (data) setAreas(data)
      setLoadingAreas(false)
    })
  }, [selectedCabang])

  return (
    <AreaContext.Provider value={{
      activeArea, setActiveArea,
      regions, cabangs, areas,
      selectedRegion, selectedCabang,
      setSelectedRegion, setSelectedCabang,
      loadingCabangs, loadingAreas,
    }}>
      {children}
    </AreaContext.Provider>
  )
}

export const useArea = () => useContext(AreaContext)
