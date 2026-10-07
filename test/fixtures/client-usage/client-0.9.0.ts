// Generated client of the mobile app 0.9.0 (swaggie style).
export const petsClient = {
  createPet(body: NewPet): Promise<Pet> {
    const url = "/api/pets";
    return fetch(url, { method: "POST", body: JSON.stringify(body) }).then(
      (response) => response.json() as Promise<Pet>,
    );
  },
  deletePet(petId: string): Promise<void> {
    let url = "/api/pets/{petId}";
    url = url.replace("{petId}", encodeURIComponent(petId));
    return fetch(url, { method: "DELETE" }).then(() => undefined);
  },
};

export interface NewPet {
  name: string;
  nickname?: string;
}

export interface Pet {
  id: string;
}
